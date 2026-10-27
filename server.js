require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { pool, initSchema } = require('./db');
const {
  notifyBookingCreated,
  notifyStatusChanged,
  notifyRescheduled,
  notifyReminder,
  getWhatsAppStatus,
} = require('./whatsapp');
const {
  notifyBookingCreatedEmail,
  notifyClinicNewBooking,
  notifyStatusChangedEmail,
  notifyRescheduledEmail,
  notifyReminderEmail,
  getEmailStatus,
} = require('./email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Formato estrito de data/hora que o banco e o resto do código esperam. Sem
// essa checagem, alguém podia mandar qualquer texto nesses campos (inclusive
// HTML/script) direto pro banco, que depois ia parar sem escape no e-mail de
// confirmação — por isso validamos logo na entrada, antes de qualquer outra coisa.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const CRON_SECRET = process.env.CRON_SECRET || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error(
    'ADMIN_PASSWORD e/ou SESSION_SECRET não estão definidas no ambiente. ' +
    'Defina as duas (veja .env.example) antes de iniciar o servidor — não existe ' +
    'mais um valor de reserva pra essas duas, de propósito.'
  );
  process.exit(1);
}

// O Render fica atrás de um proxy reverso — isso avisa o Express pra confiar
// no cabeçalho X-Forwarded-*, necessário pra identificar corretamente o IP de
// quem fez a requisição (usado no limite de tentativas abaixo) e pra saber
// que a conexão original do visitante é HTTPS (necessário pro cookie seguro).
app.set('trust proxy', 1);

// Cabeçalhos de segurança padrão (evita clickjacking, sniffing de tipo de
// arquivo, vazamento de referrer, etc.). O CSP fica desligado porque as
// páginas usam <script> inline — não tem dado sensível pra proteger nesse
// ponto específico, e um CSP mal ajustado quebraria a interface.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieSession({
  name: 'beautyplace_session',
  secret: SESSION_SECRET,
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PRODUCTION,
}));
app.use(express.static(path.join(__dirname, 'public')));

// Limite de tentativas de login do admin — sem isso, alguém poderia tentar
// adivinhar a senha repetidamente sem nenhum freio. Depois de 10 tentativas
// erradas em 15 minutos vindas do mesmo IP, bloqueia novas tentativas por um
// tempo.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.redirect('/admin/login?erro=limite'),
});

// Limite de marcações pelo formulário público — evita que um script
// automatizado lote o sistema de marcações falsas ou sobrecarregue o envio
// de e-mails.
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de marcação em pouco tempo. Tente novamente mais tarde.' },
});

// Compara dois valores em tempo constante, pra não dar nenhuma pista (por
// tempo de resposta) de quantos caracteres estão certos — proteção extra
// contra ataques de timing. Reaproveitada tanto pra senha do admin quanto
// pro token do cron (ver uso abaixo).
function safeEqual(input, expected) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) {
    // ainda assim compara contra algo do mesmo tamanho, pra não vazar o
    // tamanho certo do valor esperado por tempo de resposta
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function safePasswordMatch(input) {
  return safeEqual(input, ADMIN_PASSWORD);
}

// Envolve uma rota async e encaminha qualquer erro pro middleware de erro,
// em vez de derrubar o processo (o Express 4 não faz isso sozinho).
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- Helpers ----------
function weekdayOf(dateStr) {
  // dateStr: 'YYYY-MM-DD' -> 0=domingo..6=sabado (interpretado em UTC pra evitar bug de fuso)
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.getUTCDay();
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// ---------- Avisos em tempo real pro painel admin (Server-Sent Events) ----------
// O painel ficava checando "tem marcação nova?" a cada 15 segundos (polling).
// Isso tem um problema: o Chrome (e outros navegadores) limita bastante a
// frequência de setInterval/setTimeout de uma aba que está em segundo plano
// (minimizada ou você trocou pra outra aba) — é uma economia de bateria/CPU
// de propósito. Na prática, isso significa que, com a aba do painel em
// segundo plano, aquele polling de 15s podia demorar bem mais pra rodar de
// novo (ou quase nem rodar), e o aviso de marcação nova atrasava ou nem
// chegava. Em vez de depender só desse timer, mantemos uma conexão aberta
// (Server-Sent Events, um "canal" HTTP que fica escutando) entre o navegador
// do painel e o servidor: assim que uma marcação é criada, o servidor
// "empurra" o aviso na hora pra quem estiver com o painel aberto — isso não
// é um timer rodando no navegador, é o servidor entregando um evento de
// rede, que não sofre o mesmo tipo de limitação de aba em segundo plano.
const adminEventClients = new Set();

function broadcastNewBooking(booking) {
  const payload = `event: new-booking\ndata: ${JSON.stringify(booking)}\n\n`;
  for (const res of adminEventClients) {
    res.write(payload);
  }
}

function baseUrlOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Os horários de funcionamento suportam até dois turnos no mesmo dia (ex:
// 10h-12h e 14h-18h, com intervalo de almoço no meio). Se open_time2/
// close_time2 estiverem vazios, o dia tem só um turno corrido.
function shiftsOf(hours) {
  const shifts = [];
  if (hours && hours.open_time && hours.close_time) {
    shifts.push([toMinutes(hours.open_time), toMinutes(hours.close_time)]);
  }
  if (hours && hours.open_time2 && hours.close_time2) {
    shifts.push([toMinutes(hours.open_time2), toMinutes(hours.close_time2)]);
  }
  return shifts;
}

// Junta marcações existentes (exceto canceladas) e bloqueios de agenda
// daquele dia num único conjunto de intervalos ocupados, pra não oferecer
// (nem aceitar) horário em cima de nenhum dos dois. excludeBookingId serve
// pra remarcação: a própria marcação que está sendo movida não deve contar
// como "ocupando" o horário dela mesma.
async function getBusyRanges(date, professionalId, excludeBookingId) {
  // Marcação "pendente" muito antiga (alguém que começou mas nunca confirmou)
  // não deveria segurar o horário pra sempre — só conta como ocupado se ainda
  // está dentro dos primeiros 15 minutos, ou se já foi confirmada/concluída.
  // Filtrado por profissional: a agenda do Isac e da Geuza são independentes
  // (um horário ocupado de um não bloqueia o outro).
  const { rows: existing } = await pool.query(
    `SELECT b.id, b.booking_time, s.duration_minutes
     FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id
     WHERE b.booking_date = $1 AND b.professional_id = $2 AND b.status != 'cancelado'
       AND (b.status != 'pendente' OR b.created_at > now() - interval '15 minutes')`,
    [date, professionalId]
  );

  const bookingRanges = existing
    .filter((b) => !excludeBookingId || String(b.id) !== String(excludeBookingId))
    .map((b) => {
      const start = toMinutes(b.booking_time);
      return [start, start + b.duration_minutes];
    });

  // Bloqueio com professional_id = NULL vale pro espaço inteiro (ex: feriado,
  // fechamento do Holmes Place); com professional_id definido, só pra aquele
  // profissional (ex: folga individual).
  const { rows: blocks } = await pool.query(
    'SELECT start_time, end_time FROM blocked_periods WHERE block_date = $1 AND (professional_id = $2 OR professional_id IS NULL)',
    [date, professionalId]
  );

  const wholeDayBlocked = blocks.some((b) => !b.start_time || !b.end_time);
  const blockRanges = blocks
    .filter((b) => b.start_time && b.end_time)
    .map((b) => [toMinutes(b.start_time), toMinutes(b.end_time)]);

  return { ranges: [...bookingRanges, ...blockRanges], wholeDayBlocked };
}

async function computeSlots(date, service, professionalId, excludeBookingId) {
  const weekday = weekdayOf(date);
  const { rows: hoursRows } = await pool.query(
    'SELECT * FROM business_hours WHERE weekday = $1 AND professional_id = $2',
    [weekday, professionalId]
  );
  const hours = hoursRows[0];
  if (!hours || hours.closed) return [];

  const { ranges: busyRanges, wholeDayBlocked } = await getBusyRanges(date, professionalId, excludeBookingId);
  if (wholeDayBlocked) return [];

  const duration = service.duration_minutes;
  const slotStep = 30; // grade de horários de 30 em 30 minutos
  const shifts = shiftsOf(hours);

  const now = new Date();
  const isToday = date === now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const slots = [];
  for (const [openMin, closeMin] of shifts) {
    for (let t = openMin; t + duration <= closeMin; t += slotStep) {
      if (isToday && t <= nowMin) continue; // não oferece horário que já passou hoje
      const overlaps = busyRanges.some(([bStart, bEnd]) => t < bEnd && (t + duration) > bStart);
      if (!overlaps) slots.push(toHHMM(t));
    }
  }
  return slots;
}

async function isSlotFree(date, time, durationMinutes, professionalId, excludeBookingId) {
  const weekday = weekdayOf(date);
  const { rows: hoursRows } = await pool.query(
    'SELECT * FROM business_hours WHERE weekday = $1 AND professional_id = $2',
    [weekday, professionalId]
  );
  const hours = hoursRows[0];
  if (!hours || hours.closed) return false;

  const { ranges: busyRanges, wholeDayBlocked } = await getBusyRanges(date, professionalId, excludeBookingId);
  if (wholeDayBlocked) return false;

  const start = toMinutes(time);
  const end = start + durationMinutes;

  const shifts = shiftsOf(hours);
  const withinShift = shifts.some(([openMin, closeMin]) => start >= openMin && end <= closeMin);
  if (!withinShift) return false;

  const conflict = busyRanges.some(([bStart, bEnd]) => start < bEnd && end > bStart);
  return !conflict;
}

// ---------- API pública ----------

app.get('/api/professionals', ah(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, role, slug FROM professionals WHERE active = 1 ORDER BY sort_order, name'
  );
  res.json(rows);
}));

app.get('/api/services', ah(async (req, res) => {
  const { professional_id } = req.query;
  if (professional_id) {
    const { rows } = await pool.query(
      'SELECT id, name, duration_minutes, price_cents FROM services WHERE active = 1 AND professional_id = $1 ORDER BY name',
      [professional_id]
    );
    return res.json(rows);
  }
  const { rows } = await pool.query(
    'SELECT id, name, duration_minutes, price_cents, professional_id FROM services WHERE active = 1 ORDER BY name'
  );
  res.json(rows);
}));

app.get('/api/availability', ah(async (req, res) => {
  const { date, service_id, exclude_booking_id } = req.query;
  if (!date || !service_id) {
    return res.status(400).json({ error: 'Parâmetros "date" e "service_id" são obrigatórios.' });
  }

  const { rows: serviceRows } = await pool.query('SELECT * FROM services WHERE id = $1', [service_id]);
  const service = serviceRows[0];
  if (!service) return res.status(404).json({ error: 'Procedimento não encontrado.' });

  const slots = await computeSlots(date, service, service.professional_id, exclude_booking_id);
  res.json({ date, slots });
}));

app.post('/api/bookings', bookingLimiter, ah(async (req, res) => {
  const { service_id, client_name, client_phone, client_email, booking_date, booking_time, notes } = req.body;

  if (!service_id || !client_name || !client_phone || !client_email || !booking_date || !booking_time) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }

  if (!EMAIL_RE.test(String(client_email).trim())) {
    return res.status(400).json({ error: 'Informe um e-mail válido.' });
  }

  if (!DATE_RE.test(booking_date) || !TIME_RE.test(booking_time)) {
    return res.status(400).json({ error: 'Data ou horário em formato inválido.' });
  }

  const fieldLimits = { client_name: 150, client_phone: 30, client_email: 150, notes: 1000 };
  for (const [field, max] of Object.entries(fieldLimits)) {
    if (req.body[field] && String(req.body[field]).length > max) {
      return res.status(400).json({ error: `Campo "${field}" excede o tamanho máximo permitido.` });
    }
  }

  const { rows: serviceRows } = await pool.query('SELECT * FROM services WHERE id = $1', [service_id]);
  const service = serviceRows[0];
  if (!service) return res.status(404).json({ error: 'Procedimento não encontrado.' });
  if (!service.professional_id) {
    return res.status(409).json({ error: 'Esse procedimento ainda não tem profissional configurado.' });
  }

  // Revalida disponibilidade no servidor (evita corrida entre duas pessoas
  // marcando ao mesmo tempo, e também pega bloqueios de agenda).
  const free = await isSlotFree(booking_date, booking_time, service.duration_minutes, service.professional_id);
  if (!free) {
    return res.status(409).json({ error: 'Esse horário acabou de ficar indisponível. Escolha outro horário.' });
  }

  const cancelToken = crypto.randomUUID();

  const { rows: inserted } = await pool.query(
    `INSERT INTO bookings (professional_id, service_id, client_name, client_phone, client_email, booking_date, booking_time, notes, cancel_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [service.professional_id, service_id, client_name, client_phone, String(client_email).trim(), booking_date, booking_time, notes || null, cancelToken]
  );

  const { rows: bookingRows } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS professional_name
     FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id
     WHERE b.id = $1`,
    [inserted[0].id]
  );
  const booking = bookingRows[0];
  const baseUrl = baseUrlOf(req);

  // Avisa qualquer painel admin aberto na hora (ver explicação da função
  // broadcastNewBooking lá em cima) — antes mesmo de esperar os e-mails,
  // porque isso é instantâneo e não tem porque atrasar esse aviso específico.
  broadcastNewBooking(booking);

  // Importante: esperamos (await) esses três avisos terminarem antes de
  // responder, em vez de só disparar e seguir em frente sem esperar
  // ("fire-and-forget"). Antes era fire-and-forget, e isso tem um risco
  // real nesse tipo de hospedagem (Render): se o servidor reiniciar por
  // qualquer motivo (um novo deploy, por exemplo) bem no meio desse envio,
  // o processo antigo é encerrado e esses envios ainda em andamento somem
  // sem nunca terminar — e sem nem aparecer erro no log, porque o processo
  // já nem existe mais pra registrar o erro. Esperando aqui, a resposta ao
  // cliente só sai depois que os três já terminaram (com sucesso ou com
  // erro registrado no log), o que deixa bem mais confiável. Promise.allSettled
  // (em vez de Promise.all) garante que, se um falhar (ex: WhatsApp fora do
  // ar), os outros dois continuam e são registrados normalmente.
  const [emailClienteResult, emailClinicaResult, whatsappResult] = await Promise.allSettled([
    notifyBookingCreatedEmail(booking, baseUrl),
    notifyClinicNewBooking(booking, baseUrl),
    notifyBookingCreated(booking),
  ]);
  if (emailClienteResult.status === 'rejected') {
    console.error('Falha ao notificar o cliente por e-mail:', emailClienteResult.reason?.message || emailClienteResult.reason);
  }
  if (emailClinicaResult.status === 'rejected') {
    console.error('Falha ao notificar o Beauty Place por e-mail:', emailClinicaResult.reason?.message || emailClinicaResult.reason);
  }
  if (whatsappResult.status === 'rejected') {
    console.error('Falha ao notificar WhatsApp:', whatsappResult.reason?.message || whatsappResult.reason);
  }

  res.status(201).json({ ok: true, booking });
}));

// Página de cancelamento (link que vai no e-mail de confirmação)
app.get('/cancelar/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'cancelar.html'));
});

app.get('/api/bookings/cancel-info/:token', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.status, b.booking_date, b.booking_time, b.client_name, s.name AS service_name, p.name AS professional_name
     FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id WHERE b.cancel_token = $1`,
    [req.params.token]
  );
  const booking = rows[0];
  if (!booking) return res.status(404).json({ error: 'Marcação não encontrada. O link pode estar incorreto ou expirado.' });
  res.json({ booking });
}));

app.post('/api/bookings/cancel/:token', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS professional_name FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id WHERE b.cancel_token = $1`,
    [req.params.token]
  );
  const booking = rows[0];
  if (!booking) return res.status(404).json({ error: 'Marcação não encontrada. O link pode estar incorreto ou expirado.' });

  if (booking.status === 'cancelado') {
    return res.json({ ok: true, booking, already: true });
  }
  if (booking.status === 'concluido') {
    return res.status(400).json({ error: 'Essa marcação já foi concluída e não pode mais ser cancelada por aqui. Contacte-nos se precisar de ajuda.' });
  }

  await pool.query(`UPDATE bookings SET status = 'cancelado' WHERE id = $1`, [booking.id]);
  booking.status = 'cancelado';

  notifyStatusChangedEmail(booking).catch((err) => console.error('Falha ao notificar por e-mail:', err.message));
  notifyStatusChanged(booking).catch((err) => console.error('Falha ao notificar WhatsApp:', err.message));

  res.json({ ok: true, booking });
}));

// Disparado por um cron externo gratuito (ex: cron-job.org) uma vez por dia,
// protegido por um token simples — não usa sessão de admin porque é chamado
// por outro serviço, sem navegador/login.
app.get('/api/cron/send-reminders', ah(async (req, res) => {
  if (!CRON_SECRET || !safeEqual(req.query.token, CRON_SECRET)) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const baseUrl = baseUrlOf(req);

  const { rows } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS professional_name FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id
     WHERE b.booking_date = $1 AND b.status = 'confirmado' AND b.reminder_sent = 0`,
    [tomorrow]
  );

  let sent = 0;
  for (const booking of rows) {
    try {
      await notifyReminderEmail(booking, baseUrl);
    } catch (err) {
      console.error(`Falha ao enviar lembrete por e-mail (marcação #${booking.id}):`, err.message);
    }
    try {
      await notifyReminder(booking);
    } catch (err) {
      console.error(`Falha ao enviar lembrete por WhatsApp (marcação #${booking.id}):`, err.message);
    }
    await pool.query('UPDATE bookings SET reminder_sent = 1 WHERE id = $1', [booking.id]);
    sent++;
  }

  res.json({ ok: true, date: tomorrow, remindersSent: sent, total: rows.length });
}));

// ---------- Admin ----------

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-login.html'));
});

app.post('/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (safePasswordMatch(password)) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?erro=1');
});

app.post('/admin/logout', (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/api/admin/whatsapp-status', requireAdmin, (req, res) => {
  res.json({ status: getWhatsAppStatus() });
});

app.get('/api/admin/email-status', requireAdmin, (req, res) => {
  res.json({ status: getEmailStatus() });
});

app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n'); // linha de comentário SSE, só confirma que a conexão abriu

  adminEventClients.add(res);

  // Sem tráfego nenhum por um tempo, alguns proxies/hospedagens (incluindo o
  // Render) derrubam conexões ociosas sozinhos — esse "ping" periódico evita
  // isso, mantendo a conexão viva mesmo sem marcação nenhuma chegando.
  const keepAlive = setInterval(() => res.write(':ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    adminEventClients.delete(res);
  });
});

app.get('/api/admin/bookings', requireAdmin, ah(async (req, res) => {
  // Mostra primeiro hoje/futuro (da mais próxima pra mais distante) e só depois
  // marcações de datas passadas que ficaram "penduradas" sem ser marcadas como
  // concluídas ou canceladas — senão essas marcações antigas e esquecidas
  // aparecem no topo da lista (por terem a data "menor"), enterrando as de
  // hoje/próximas, que são as que realmente importam no dia a dia.
  const { rows } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS professional_name
     FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id
     ORDER BY
       CASE WHEN b.booking_date >= CURRENT_DATE::text THEN 0 ELSE 1 END,
       CASE WHEN b.booking_date >= CURRENT_DATE::text THEN b.booking_date END ASC,
       CASE WHEN b.booking_date >= CURRENT_DATE::text THEN b.booking_time END ASC,
       CASE WHEN b.booking_date < CURRENT_DATE::text THEN b.booking_date END DESC,
       CASE WHEN b.booking_date < CURRENT_DATE::text THEN b.booking_time END DESC`
  );
  res.json(rows);
}));

app.post('/api/admin/bookings/:id/status', requireAdmin, ah(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['pendente', 'confirmado', 'cancelado', 'concluido'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }
  await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, id]);
  const { rows } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS professional_name FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id WHERE b.id = $1`,
    [id]
  );
  const booking = rows[0];

  if (status === 'confirmado' || status === 'cancelado') {
    const baseUrl = baseUrlOf(req);
    notifyStatusChangedEmail(booking, baseUrl).catch((err) => console.error('Falha ao notificar por e-mail:', err.message));
    notifyStatusChanged(booking).catch((err) => console.error('Falha ao notificar WhatsApp:', err.message));
  }

  res.json({ ok: true, booking });
}));

// Marcação manual feita pelo próprio Beauty Place (ex: cliente que pergunta
// horário disponível pelo telemóvel/WhatsApp) — mesmo fluxo do site público,
// mas já entra como "confirmado" direto.
app.post('/api/admin/bookings', requireAdmin, ah(async (req, res) => {
  const { service_id, client_name, client_phone, client_email, booking_date, booking_time, notes } = req.body;

  if (!service_id || !client_name || !client_phone || !booking_date || !booking_time) {
    return res.status(400).json({ error: 'Preencha procedimento, nome, telefone, data e horário.' });
  }
  if (client_email && !EMAIL_RE.test(String(client_email).trim())) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  if (!DATE_RE.test(booking_date) || !TIME_RE.test(booking_time)) {
    return res.status(400).json({ error: 'Data ou horário em formato inválido.' });
  }

  const fieldLimits = { client_name: 150, client_phone: 30, client_email: 150, notes: 1000 };
  for (const [field, max] of Object.entries(fieldLimits)) {
    if (req.body[field] && String(req.body[field]).length > max) {
      return res.status(400).json({ error: `Campo "${field}" excede o tamanho máximo permitido.` });
    }
  }

  const { rows: serviceRows } = await pool.query('SELECT * FROM services WHERE id = $1', [service_id]);
  const service = serviceRows[0];
  if (!service) return res.status(404).json({ error: 'Procedimento não encontrado.' });
  if (!service.professional_id) {
    return res.status(409).json({ error: 'Esse procedimento ainda não tem profissional configurado.' });
  }

  const free = await isSlotFree(booking_date, booking_time, service.duration_minutes, service.professional_id);
  if (!free) {
    return res.status(409).json({ error: 'Esse horário não está disponível.' });
  }

  const cancelToken = crypto.randomUUID();

  const { rows: inserted } = await pool.query(
    `INSERT INTO bookings (professional_id, service_id, client_name, client_phone, client_email, booking_date, booking_time, notes, status, cancel_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmado', $9)
     RETURNING id`,
    [service.professional_id, service_id, client_name, client_phone, client_email ? String(client_email).trim() : null, booking_date, booking_time, notes || null, cancelToken]
  );

  const { rows: bookingRows } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS professional_name FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id WHERE b.id = $1`,
    [inserted[0].id]
  );
  const booking = bookingRows[0];
  const baseUrl = baseUrlOf(req);

  notifyStatusChangedEmail(booking, baseUrl).catch((err) => console.error('Falha ao notificar por e-mail:', err.message));
  notifyStatusChanged(booking).catch((err) => console.error('Falha ao notificar WhatsApp:', err.message));

  res.status(201).json({ ok: true, booking });
}));

// Remarcar (trocar data/horário) uma marcação existente, sem perder o histórico.
app.post('/api/admin/bookings/:id/reschedule', requireAdmin, ah(async (req, res) => {
  const { id } = req.params;
  const { booking_date, booking_time } = req.body;
  if (!booking_date || !booking_time) {
    return res.status(400).json({ error: 'Informe a nova data e horário.' });
  }
  if (!DATE_RE.test(booking_date) || !TIME_RE.test(booking_time)) {
    return res.status(400).json({ error: 'Data ou horário em formato inválido.' });
  }

  const { rows: existingRows } = await pool.query(
    `SELECT b.*, s.duration_minutes, s.name AS service_name
     FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id WHERE b.id = $1`,
    [id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Marcação não encontrada.' });

  const free = await isSlotFree(booking_date, booking_time, existing.duration_minutes, existing.professional_id, id);
  if (!free) {
    return res.status(409).json({ error: 'Esse horário não está disponível.' });
  }

  await pool.query(
    'UPDATE bookings SET booking_date = $1, booking_time = $2, reminder_sent = 0 WHERE id = $3',
    [booking_date, booking_time, id]
  );
  const { rows } = await pool.query(
    `SELECT b.*, s.name AS service_name, p.name AS professional_name FROM bookings b JOIN services s ON s.id = b.service_id
     LEFT JOIN professionals p ON p.id = b.professional_id WHERE b.id = $1`,
    [id]
  );
  const booking = rows[0];
  const baseUrl = baseUrlOf(req);

  notifyRescheduledEmail(booking, baseUrl).catch((err) => console.error('Falha ao notificar por e-mail:', err.message));
  notifyRescheduled(booking).catch((err) => console.error('Falha ao notificar WhatsApp:', err.message));

  res.json({ ok: true, booking });
}));

// Bloqueio de agenda (folga, consulta pessoal, feriado) — impede novas
// marcações no período, sem mexer em marcações já existentes.
app.get('/api/admin/blocks', requireAdmin, ah(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT bp.*, p.name AS professional_name
     FROM blocked_periods bp LEFT JOIN professionals p ON p.id = bp.professional_id
     WHERE bp.block_date >= $1 ORDER BY bp.block_date ASC, bp.start_time ASC NULLS FIRST`,
    [today]
  );
  res.json(rows);
}));

// professional_id vazio/ausente bloqueia o espaço inteiro (ex: feriado,
// fechamento do Holmes Place); com um profissional escolhido, bloqueia só a
// agenda dele (ex: folga individual do Isac ou da Geuza).
app.post('/api/admin/blocks', requireAdmin, ah(async (req, res) => {
  const { block_date, start_time, end_time, reason, professional_id } = req.body;
  if (!block_date) {
    return res.status(400).json({ error: 'Informe a data a bloquear.' });
  }
  if ((start_time && !end_time) || (!start_time && end_time)) {
    return res.status(400).json({ error: 'Informe início e fim do bloqueio, ou deixe os dois em branco pra bloquear o dia inteiro.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO blocked_periods (block_date, start_time, end_time, reason, professional_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [block_date, start_time || null, end_time || null, reason || null, professional_id || null]
  );
  res.status(201).json({ ok: true, block: rows[0] });
}));

app.delete('/api/admin/blocks/:id', requireAdmin, ah(async (req, res) => {
  await pool.query('DELETE FROM blocked_periods WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Middleware de erro — pega qualquer falha de banco/rota async e devolve JSON
// em vez de derrubar o servidor ou travar a requisição sem resposta.
app.use((err, req, res, next) => {
  console.error('Erro na requisição:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno no servidor. Tente novamente em instantes.' });
});

async function start() {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`Beauty Place Agendamento rodando em http://localhost:${PORT}`);
    // Propositalmente não imprime a senha do admin aqui — evita deixar a
    // senha gravada em texto puro nos logs do servidor (Render guarda
    // histórico de logs, e não é um lugar seguro pra senha ficar visível).
    console.log(`Painel admin disponível em http://localhost:${PORT}/admin`);
  });
}

start().catch((err) => {
  console.error('Erro ao iniciar o servidor:', err.message);
  process.exit(1);
});
