'use strict';

// ---------------------------------------------------------------------------
// CONFIGURACIÓN (lo único que quizá haya que ajustar)
// ---------------------------------------------------------------------------
// Comunicación BLE UART del JDY-3X. Perfil frecuente: servicio FFE0, característica FFE1.
// NO confirmados con el módulo físico: si no conecta, cambiar solo estas dos líneas.
const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const UART_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

// Calibración del sensor de flujo: pulsos por segundo (Hz) que entrega el sensor
// por cada 1 L/min (dato del fabricante del modelo exacto).
// null = sin calibrar: la web NO calcula caudal, solo muestra presencia de flujo y pulsos/s.
const FLOW_HZ_PER_LPM = null;

// ---------------------------------------------------------------------------
// Referencias
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const flowStateElement = $('flowState');
const flowUnitElement = $('flowUnit');
const flowNote = $('flowNote');
const bpmElement = $('bpm');
const modeLabel = $('modeLabel');
const message = $('message');
const historyElement = $('history');
const stopButton = $('stopBtn');
const connectButton = $('connectBtn');
const canvas = $('flowChart');
const ctx = canvas.getContext('2d');

let device = null;
let gattServer = null;
let uartCharacteristic = null;
let incomingText = '';
let discardPartial = true;
let textDecoder = new TextDecoder();

// Estado informado por el PIC (nada de esto se inventa)
let systemState = null;   // 'activo' | 'detenido' | null (desconocido)
let currentMode = null;   // 'NORMAL' | 'TAQUI' | 'BRADI' | null
let lastBpm = null;       // BPM programado que transmite el PIC
let lastPumpPulse = null; // 'ON' | 'OFF' (muestra de la bomba cada 1 s)

// Serie de la gráfica: solo datos recibidos del PIC.
let chartData = [];
let chartKind = null;     // 'pulsos' | 'caudal'
let chartUnit = '';

// ---------------------------------------------------------------------------
// Registro de eventos y estado de conexión
// ---------------------------------------------------------------------------
function addEvent(description) {
  const item = document.createElement('div');
  item.className = 'history-item';
  const label = document.createElement('span');
  const time = document.createElement('span');
  label.textContent = description;
  time.textContent = new Date().toLocaleTimeString();
  item.append(label, time);
  historyElement.prepend(item);
  while (historyElement.children.length > 8) {
    historyElement.lastElementChild.remove();
  }
}

function setConnectionState(state, detail) {
  const connected = state === 'connected';
  const badge = $('systemBadge');
  const dot = $('connectionDot');

  badge.textContent = connected ? 'CONECTADO' :
    state === 'error' ? 'ERROR DE CONEXIÓN' : 'DESCONECTADO';
  badge.className = 'badge ' + state;
  dot.className = 'dot ' + state;
  $('connectionStatus').textContent = connected
    ? (device?.name || 'JDY-3X conectado')
    : state === 'error' ? 'No se pudo conectar' : 'JDY-3X desconectado';

  connectButton.textContent = connected ? 'DESCONECTAR' : 'CONECTAR';
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.disabled = !connected;
  });
  stopButton.disabled = !connected;
  $('connectionNote').textContent = detail || (connected
    ? 'Enlace Bluetooth activo.'
    : 'Usa Chrome o Edge y activa el JDY-3X.');
}

function setMessage(text) {
  message.textContent = text;
}

// ---------------------------------------------------------------------------
// Envío de órdenes al PIC (N, T, B, S)
// ---------------------------------------------------------------------------
async function sendCommand(command, label) {
  if (!uartCharacteristic || !device?.gatt?.connected) {
    setMessage('No hay conexión Bluetooth. Conecta el JDY-3X primero.');
    return false;
  }
  try {
    const bytes = new TextEncoder().encode(command);
    if (uartCharacteristic.properties.writeWithoutResponse &&
        uartCharacteristic.writeValueWithoutResponse) {
      await uartCharacteristic.writeValueWithoutResponse(bytes);
    } else if (uartCharacteristic.properties.write &&
               uartCharacteristic.writeValueWithResponse) {
      await uartCharacteristic.writeValueWithResponse(bytes);
    } else {
      await uartCharacteristic.writeValue(bytes);
    }
    setMessage(`Orden ${label} enviada al JDY-3X.`);
    addEvent(`Orden enviada: ${label}`);
    return true;
  } catch (error) {
    setMessage(`Error al enviar ${label}: ${error.message}`);
    addEvent(`Error al enviar ${label}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Presentación de datos del PIC
// ---------------------------------------------------------------------------
function setActiveButton(mode) {
  document.querySelectorAll('[data-mode]').forEach(item => {
    item.classList.toggle('active', item.dataset.mode === mode);
  });
}

function renderPump() {
  if (systemState === null) {
    bpmElement.textContent = '--';
    modeLabel.textContent = 'Sin datos del PIC todavía';
    return;
  }
  if (systemState === 'detenido') {
    bpmElement.textContent = '--';
    modeLabel.textContent = 'Bomba detenida (STOP)';
    return;
  }
  bpmElement.textContent = lastBpm === null ? '--' : String(lastBpm);
  const pulse = lastPumpPulse ? ` · bomba ${lastPumpPulse}` : '';
  modeLabel.textContent = `Modo ${currentMode || '--'} · valor programado en el PIC, no medido${pulse}`;
}

function setFlowPresence(hasFlow, note) {
  flowStateElement.textContent = hasFlow ? 'CON FLUJO' : 'SIN FLUJO';
  flowStateElement.className = 'text-state ' + (hasFlow ? 'flow-on' : 'flow-off');
  flowNote.textContent = note;
}

function pushChart(kind, value, unit) {
  if (!Number.isFinite(value)) return;
  if (chartKind !== kind) { chartData = []; chartKind = kind; }
  chartUnit = unit;
  chartData.push(value);
  if (chartData.length > 40) chartData.shift();
  $('chartTitle').textContent = kind === 'caudal'
    ? 'Caudal en el circuito'
    : 'Pulsos del sensor de flujo (por segundo)';
  $('chartStatus').textContent = 'Recibiendo datos';
  drawChart();
}

function handleFlowPulses(pulsesPerSecond) {
  const hasFlow = pulsesPerSecond > 0;
  if (FLOW_HZ_PER_LPM) {
    const flow = pulsesPerSecond / FLOW_HZ_PER_LPM;
    flowStateElement.textContent = flow.toFixed(2);
    flowStateElement.className = 'text-state ' + (hasFlow ? 'flow-on' : 'flow-off');
    flowUnitElement.textContent = 'L/min';
    flowNote.textContent = `Calculado de ${pulsesPerSecond} pulsos/s con la calibración configurada`;
    pushChart('caudal', flow, 'L/min');
  } else {
    flowUnitElement.textContent = '';
    setFlowPresence(hasFlow, `${pulsesPerSecond} pulsos/s recibidos · sin calibrar, no es caudal`);
    pushChart('pulsos', pulsesPerSecond, 'pulsos/s');
  }
}

// ---------------------------------------------------------------------------
// Lectura de líneas que transmite el firmware (terminan en \r\n)
//   FLUJO_PULSOS=12   BPM=60   BOMBA=ON|OFF
//   MODO NORMAL | MODO TAQUI | MODO BRADI | BOMBA DETENIDA | CARDIOFLOW INICIADO
// ---------------------------------------------------------------------------
function parseReceivedLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return;

  let match;

  if ((match = line.match(/PULSOS?\s*[=:]\s*(\d+)/i))) {
    handleFlowPulses(Number(match[1]));
    setMessage('Datos recibidos desde el PIC por Bluetooth.');
    return;
  }

  if ((match = line.match(/^BPM\s*[=:]\s*(\d+)/i))) {
    lastBpm = Number(match[1]);
    renderPump();
    return;
  }

  if ((match = line.match(/^BOMBA\s*[=:]\s*(ON|OFF)\b/i))) {
    lastPumpPulse = match[1].toUpperCase();
    renderPump();
    return;
  }

  if (/^BOMBA\s+DETENIDA/i.test(line)) {
    systemState = 'detenido';
    setActiveButton(null);
    renderPump();
    setMessage('El PIC confirmó: bomba detenida.');
    addEvent('PIC: bomba detenida');
    return;
  }

  if ((match = line.match(/^MODO\s+(NORMAL|TAQUI|BRADI)/i))) {
    currentMode = match[1].toUpperCase();
    systemState = 'activo';
    lastBpm = null; // se espera el BPM del nuevo modo en el siguiente reporte (1 s)
    setActiveButton(currentMode);
    renderPump();
    setMessage(`El PIC confirmó modo ${currentMode}.`);
    addEvent(`PIC: modo ${currentMode}`);
    return;
  }

  if (/^CARDIOFLOW\s+INICIADO/i.test(line)) {
    // Al iniciar, el firmware arranca en modo NORMAL con la bomba activa.
    currentMode = 'NORMAL';
    systemState = 'activo';
    lastBpm = null;
    setActiveButton('NORMAL');
    renderPump();
    setMessage('El PIC informó que se inició (arranca en NORMAL).');
    addEvent('PIC iniciado');
    return;
  }

  if (/^OK\b/i.test(line)) {
    setMessage('El PIC respondió OK a través del enlace Bluetooth.');
    return;
  }

  setMessage(`Dato recibido: ${line.slice(0, 100)}`);
}

function handleNotification(event) {
  incomingText += textDecoder.decode(event.target.value);

  // Al conectar, el primer fragmento puede llegar a mitad de línea: se descarta hasta el primer salto.
  if (discardPartial) {
    const cut = incomingText.indexOf('\n');
    if (cut === -1) { incomingText = ''; return; }
    incomingText = incomingText.slice(cut + 1);
    discardPartial = false;
  }

  const lines = incomingText.split(/\r?\n/);
  incomingText = lines.pop() || '';
  lines.forEach(parseReceivedLine);
}

// ---------------------------------------------------------------------------
// Conexión Bluetooth
// ---------------------------------------------------------------------------
async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setConnectionState('error', 'Web Bluetooth no está disponible. Abre este enlace HTTPS en Chrome o Edge desde un equipo compatible.');
    setMessage('Este navegador no admite Web Bluetooth.');
    return;
  }

  try {
    connectButton.disabled = true;
    setMessage('Buscando el JDY-3X. Selecciónalo en la ventana Bluetooth…');

    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID]
    });

    device.addEventListener('gattserverdisconnected', onDisconnected);
    gattServer = await device.gatt.connect();

    const service = await gattServer.getPrimaryService(SERVICE_UUID);
    uartCharacteristic = await service.getCharacteristic(UART_UUID);

    incomingText = '';
    discardPartial = true;
    if (uartCharacteristic.properties.notify || uartCharacteristic.properties.indicate) {
      await uartCharacteristic.startNotifications();
      uartCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);
    }

    setConnectionState('connected', `Conectado a ${device.name || 'JDY-3X'}. Ya puedes enviar órdenes.`);
    setMessage('Bluetooth conectado. Los controles están habilitados.');
    addEvent(`Bluetooth conectado: ${device.name || 'JDY-3X'}`);
    // Se manda STOP al conectar para iniciar en estado detenido.
    await sendCommand('S', 'DETENER (inicial)');
  } catch (error) {
    uartCharacteristic = null;
    gattServer = null;
    setConnectionState('error', 'No se completó la conexión. Verifica que el JDY-3X esté encendido y no conectado a otro dispositivo.');
    setMessage(`No se pudo conectar: ${error.message}`);
    addEvent('Falló la conexión Bluetooth');
  } finally {
    connectButton.disabled = false;
  }
}

function onDisconnected() {
  uartCharacteristic = null;
  gattServer = null;
  incomingText = '';
  systemState = null;
  currentMode = null;
  lastBpm = null;
  lastPumpPulse = null;
  setActiveButton(null);
  renderPump();
  setConnectionState('disconnected', 'El JDY-3X se desconectó. Puedes volver a conectarlo.');
  setMessage('Conexión Bluetooth perdida. Los controles quedaron deshabilitados.');
  addEvent('Bluetooth desconectado');
}

async function disconnectBluetooth() {
  if (device?.gatt?.connected) device.gatt.disconnect();
  onDisconnected();
}

document.querySelectorAll('[data-mode]').forEach(button => {
  button.addEventListener('click', async () => {
    const mode = button.dataset.mode;
    const command = { NORMAL: 'N', TAQUI: 'T', BRADI: 'B' }[mode];
    // La tarjeta de frecuencia se actualiza cuando el PIC confirma con "MODO ...".
    if (await sendCommand(command, mode)) setActiveButton(mode);
  });
});

stopButton.addEventListener('click', async () => {
  // La tarjeta se actualiza cuando el PIC confirma con "BOMBA DETENIDA".
  if (await sendCommand('S', 'DETENER')) setActiveButton(null);
});

connectButton.addEventListener('click', () => {
  if (device?.gatt?.connected) disconnectBluetooth();
  else connectBluetooth();
});

// ---------------------------------------------------------------------------
// Gráfica (solo datos reales recibidos)
// ---------------------------------------------------------------------------
function drawChart() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = '#263b4e';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (chartData.length < 2) return;
  const minValue = 0;
  const maxValue = Math.max(1, ...chartData) * 1.15;
  const range = maxValue - minValue;

  ctx.fillStyle = '#8da4b8';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(`${maxValue.toFixed(1)} ${chartUnit}`.trim(), 6, 14);
  ctx.fillText('0', 6, height - 6);

  ctx.strokeStyle = '#45d6d0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  chartData.forEach((value, index) => {
    const x = (index / (chartData.length - 1)) * width;
    const y = height - ((value - minValue) / range) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

window.addEventListener('resize', drawChart);
setConnectionState('disconnected');
renderPump();
drawChart();
