// Integração com WhatsApp via Baileys — mesma abordagem usada no bot de horas
// extras (conecta no WhatsApp escaneando um QR code, igual parear o WhatsApp Web).
//
// Modo simulado (padrão, WHATSAPP_ENABLED=false): só imprime no console o que
// seria enviado — útil pra testar o fluxo de marcações sem conectar nenhum número.
//
// Modo real (WHATSAPP_ENABLED=true):
//   1. npm install (já inclui @whiskeysockets/baileys, qrcode-terminal e @hapi/boom)
//   2. Defina WHATSAPP_ENABLED=true no .env
//   3. Rode "npm start" — um QR code vai aparecer no terminal
//   4. No telemóvel do Beauty Place: WhatsApp > Aparelhos conectados >
//      Conectar aparelho e leia o QR code
//   5. A sessão fica salva em data/auth/ — nas próximas vezes que o servidor
//      subir, ele reconecta sozinho, sem pedir QR code de novo (a menos que
//      a pasta data/auth seja apagada ou o aparelho seja desconectado pelo
//      celular)

const path = require('path');
const fs = require('fs');

const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === 'true';
const authDir = path.join(__dirname, 'data', 'auth');

let sock = null;
// 'desativado' | 'conectando' | 'aguardando_qr' | 'conectado' | 'desconectado' | 'erro'
let connectionStatus = WHATSAPP_ENABLED ? 'conectando' : 'desativado';

function formatPhoneForWhatsApp(phone) {
  // Remove tudo que não é número. DDI 351 = Portugal (Beauty Place fica em
  // Braga). Se o número já vier com o 351 na frente, mantém como está.
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('351')) return digits;
  return `351${digits}`;
}

async function connectWhatsApp() {
  const baileys = require('@whiskeysockets/baileys');
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
  const qrcodeTerminal = require('qrcode-terminal');
  const { Boom } = require('@hapi/boom');

  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // o QR é desenhado manualmente abaixo com qrcode-terminal
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'aguardando_qr';
      console.log('\n📱 Leia o QR code abaixo com o WhatsApp do Beauty Place (Aparelhos conectados > Conectar aparelho):\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionStatus = 'conectado';
      console.log('✅ WhatsApp conectado com sucesso. As notificações já vão ser enviadas de verdade.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect && lastDisconnect.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : null;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        connectionStatus = 'desconectado';
        console.log('⚠️  WhatsApp desconectado (sessão encerrada pelo celular). Apague a pasta data/auth e reinicie o servidor pra parear de novo.');
      } else {
        connectionStatus = 'conectando';
        console.log('🔁 Conexão com WhatsApp caiu, tentando reconectar em 5s...');
        setTimeout(() => {
          connectWhatsApp().catch(err => {
            connectionStatus = 'erro';
            console.error('Erro ao reconectar WhatsApp:', err.message);
          });
        }, 5000);
      }
    }
  });
}

if (WHATSAPP_ENABLED) {
  connectWhatsApp().catch(err => {
    connectionStatus = 'erro';
    console.error('Erro ao iniciar conexão com WhatsApp:', err.message);
  });
}

function getWhatsAppStatus() {
  return connectionStatus;
}

async function sendWhatsAppMessage(phone, message) {
  const to = formatPhoneForWhatsApp(phone);

  if (!WHATSAPP_ENABLED) {
    console.log('--- [WhatsApp simulado — defina WHATSAPP_ENABLED=true pra enviar de verdade] ---');
    console.log(`Para: ${to}`);
    console.log(message);
    console.log('------------------------------------------------------------------------------');
    return;
  }

  if (!sock || connectionStatus !== 'conectado') {
    throw new Error(`WhatsApp ainda não está conectado (status: ${connectionStatus}). A mensagem não foi enviada.`);
  }

  await sock.sendMessage(`${to}@s.whatsapp.net`, { text: message });
}

function formatDateBR(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

async function notifyBookingCreated(booking) {
  const message =
    `Olá, ${booking.client_name}! ✂️\n\n` +
    `A sua marcação no *Beauty Place* foi recebida:\n\n` +
    `${booking.professional_name ? `💈 Profissional: ${booking.professional_name}\n` : ''}` +
    `📋 Procedimento: ${booking.service_name}\n` +
    `📅 Data: ${formatDateBR(booking.booking_date)}\n` +
    `🕐 Horário: ${booking.booking_time}\n\n` +
    `Em breve confirmamos o seu horário. Qualquer dúvida, basta responder aqui.`;

  await sendWhatsAppMessage(booking.client_phone, message);
}

async function notifyStatusChanged(booking) {
  if (booking.status === 'confirmado') {
    const message =
      `Olá, ${booking.client_name}! ✅\n\n` +
      `A sua marcação no *Beauty Place* foi *confirmada*:\n\n` +
      `${booking.professional_name ? `💈 ${booking.professional_name}\n` : ''}` +
      `📋 ${booking.service_name}\n` +
      `📅 ${formatDateBR(booking.booking_date)} às ${booking.booking_time}\n\n` +
      `Até lá!`;
    await sendWhatsAppMessage(booking.client_phone, message);
  } else if (booking.status === 'cancelado') {
    const message =
      `Olá, ${booking.client_name}.\n\n` +
      `A sua marcação no *Beauty Place* do dia ${formatDateBR(booking.booking_date)} às ${booking.booking_time} foi *cancelada*.\n\n` +
      `Para remarcar, basta aceder ao site novamente ou contactar-nos pelo WhatsApp.`;
    await sendWhatsAppMessage(booking.client_phone, message);
  }
}

async function notifyRescheduled(booking) {
  const message =
    `Olá, ${booking.client_name}.\n\n` +
    `A sua marcação no *Beauty Place* foi remarcada:\n\n` +
    `${booking.professional_name ? `💈 ${booking.professional_name}\n` : ''}` +
    `📋 ${booking.service_name}\n` +
    `📅 Nova data: ${formatDateBR(booking.booking_date)}\n` +
    `🕐 Novo horário: ${booking.booking_time}\n\n` +
    `Qualquer dúvida, basta responder aqui.`;
  await sendWhatsAppMessage(booking.client_phone, message);
}

async function notifyReminder(booking) {
  const message =
    `Olá, ${booking.client_name}! ⏰\n\n` +
    `Lembramos que tem uma marcação *amanhã* no Beauty Place:\n\n` +
    `${booking.professional_name ? `💈 ${booking.professional_name}\n` : ''}` +
    `📋 ${booking.service_name}\n` +
    `📅 ${formatDateBR(booking.booking_date)}\n` +
    `🕐 ${booking.booking_time}\n\n` +
    `Até lá! Se não puder comparecer, avise-nos com antecedência.`;
  await sendWhatsAppMessage(booking.client_phone, message);
}

module.exports = {
  notifyBookingCreated,
  notifyStatusChanged,
  notifyRescheduled,
  notifyReminder,
  getWhatsAppStatus,
};
