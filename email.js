// Integração de e-mail via Brevo (serviço terceiro, API HTTP) — usada para
// enviar a confirmação de marcação, lembretes e o link de cancelamento por
// e-mail ao cliente. O Beauty Place já divulga um número de telemóvel/WhatsApp
// (+351 926 291 818) no site, mas o e-mail continua sendo o canal mais fiável
// pra confirmações automáticas — não depende de alguém responder manualmente.
//
// Chegamos a testar o envio direto via SMTP (sem Brevo) no projeto-base, mas
// o plano gratuito do Render bloqueia as portas de SMTP (25, 465, 587) desde
// set/2025 — então essa conexão nunca chega a sair do servidor. Por isso o
// Brevo, que usa HTTPS (porta 443), não bloqueada no plano gratuito.
//
// Aviso: se o remetente configurado for um e-mail de domínio gratuito (ex:
// @outlook.com, @gmail.com) em vez de um domínio próprio do Beauty Place,
// alguns provedores de e-mail podem classificar a mensagem como spam — é esse
// o motivo de existir o SPAM_NOTE no rodapé de cada e-mail. Pra resolver isso
// de forma mais definitiva, o caminho é comprar um domínio próprio e
// configurar SPF/DKIM pra ele no Brevo.
//
// Modo simulado (padrão, sem BREVO_API_KEY configurado): só imprime no
// console o que seria enviado — útil pra testar o fluxo sem mandar e-mail
// de verdade.
//
// Modo real: crie uma conta grátis em brevo.com, gere uma API key em
// Configurações > SMTP & API > API Keys, e defina BREVO_API_KEY e
// BREVO_SENDER_EMAIL (o e-mail verificado na conta Brevo, usado como
// remetente) nas variáveis de ambiente.

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const EMAIL_SENDER_NAME = process.env.EMAIL_SENDER_NAME || 'Beauty Place';
// E-mail que recebe o aviso de "nova marcação" (pra não depender só de ficar
// checando o painel). Se não for definido, cai pro mesmo e-mail usado como
// remetente — então já funciona sem configurar nada a mais, e dá pra trocar
// depois se quiserem receber num endereço diferente.
const BUSINESS_NOTIFICATION_EMAIL = process.env.BUSINESS_NOTIFICATION_EMAIL || BREVO_SENDER_EMAIL;
// Endereço físico exibido no rodapé dos e-mails — alguns filtros de spam usam
// a presença de um endereço real como sinal de que é uma mensagem
// transacional legítima, não spam. Deixe em branco pra omitir essa linha
// enquanto o endereço exato não estiver definido.
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS || 'Holmes Place Braga — Quinta do Seminário, Av. Alfredo Barros 180, Braga';

const EMAIL_ENABLED = Boolean(BREVO_API_KEY && BREVO_SENDER_EMAIL);

if (!EMAIL_ENABLED) {
  console.warn(
    '⚠️  BREVO_API_KEY e/ou BREVO_SENDER_EMAIL não configurados — os e-mails de ' +
    'confirmação/lembrete vão rodar em modo simulado (só aparecem no console).'
  );
}

function formatDateBR(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// Domínio usado como fallback pra montar links absolutos quando a função de
// e-mail é chamada sem baseUrl (ex: o lembrete automático, disparado pelo
// cron, não tem uma requisição HTTP de onde tirar o host).
//
// ATENÇÃO (placeholder): ainda não sabemos o domínio real de produção do
// Beauty Place (depende do nome do serviço criado no Render). Atualize esta
// constante assim que o serviço for criado/deployado.
const FALLBACK_DOMAIN = 'https://beautyplace-agendamento.onrender.com';

// Monta o cabeçalho de todo e-mail com o logo real do Beauty Place (imagem,
// não texto) — reproduz fielmente o logo que o cliente enviou (colchetes
// finos, "beauty" leve + "place" negrito, "for gym" embaixo).
//
// Usa logo-email.png com fundo preto já "assado" na própria imagem (pixels
// opacos, sem transparência) — a mesma técnica usada no projeto-base
// (Santé), só que com fundo escuro em vez de claro, já que o tema do Beauty
// Place é escuro/dourado. Isso é necessário porque o Outlook, no modo
// escuro, reprocessa qualquer PNG com canal alfa e pode escurecer partes
// transparentes de forma imprevisível — uma imagem 100% opaca evita esse
// problema. Por isso também NÃO colocamos nenhum <div> com background-color
// ao redor da imagem (testado no projeto-base: até o bgcolor em HTML foi
// escurecido pelo Outlook no modo escuro do celular).
function logoHeader(baseUrl) {
  const logoUrl = `${baseUrl || FALLBACK_DOMAIN}/img/logo-email.png`;
  return `<div style="text-align:center;margin-bottom:22px;"><img src="${logoUrl}" alt="Beauty Place — Barbearia e Cabeleireiro" width="300" style="width:300px;max-width:88%;height:auto;display:block;margin:0 auto;border:0;"></div>`;
}

// Envolve o corpo do e-mail num documento HTML completo (com <head> e meta
// tags), em vez de mandar só o trecho de conteúdo. Isso é necessário porque
// vários apps de e-mail no modo escuro (Outlook no celular é o pior caso)
// reprocessam as cores da mensagem inteira. As tags "color-scheme"/
// "supported-color-schemes" avisam o app pra sempre renderizar esse e-mail
// específico no modo claro, ignorando o tema do celular da pessoa.
//
// Mantido com fundo claro mesmo o site público usando um tema escuro/dourado
// — e-mails transacionais em fundo claro têm melhor compatibilidade e
// legibilidade entre provedores, e é o que resistiu aos testes de modo
// escuro no projeto-base.
function wrapEmailDocument(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  body { background-color: #ffffff !important; }
</style>
</head>
<body style="background-color:#ffffff;margin:0;padding:24px 14px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <div style="max-width:520px;margin:0 auto;">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// Aviso incluído no rodapé de todo e-mail — útil enquanto o remetente for um
// e-mail de domínio gratuito, que tem mais chance de cair no spam de alguns
// provedores do que um domínio próprio verificado.
const SPAM_NOTE = '<p style="font-size:12px;color:#999;margin-top:24px;">Não encontrou este e-mail na caixa de entrada? Veja na pasta de spam/lixo eletrónico.</p>';

// Endereço no rodapé — sinal extra (gratuito) que alguns filtros de spam usam
// pra identificar mensagem transacional legítima.
const ADDRESS_NOTE = BUSINESS_ADDRESS
  ? `<p style="font-size:12px;color:#999;margin-top:4px;">Beauty Place — ${escapeHtml(BUSINESS_ADDRESS)}</p>`
  : '';

// Escapa texto preenchido pelo cliente (nome) antes de montar o HTML do
// e-mail — evita que alguém injete HTML/links estranhos num campo de texto.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function getEmailStatus() {
  return EMAIL_ENABLED ? 'ativo' : 'simulado';
}

// Monta o link de cancelamento (ex: https://beautyplace-agendamento.onrender.com/cancelar/<token>).
// baseUrl vem de req.protocol + req.get('host'), calculado no server.js — assim
// funciona tanto em localhost quanto no domínio real, sem precisar fixar no código.
function cancelLink(baseUrl, booking) {
  if (!baseUrl || !booking.cancel_token) return null;
  return `${baseUrl}/cancelar/${booking.cancel_token}`;
}

// Monta uma versão em texto puro a partir do HTML — alguns filtros de spam
// pontuam pior um e-mail que só tem HTML, sem nenhuma alternativa em texto
// (é um padrão de e-mail legítimo ter as duas versões, não só a bonita).
function toPlainText(htmlContent) {
  return htmlContent
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<li>/gi, '- ')
    .replace(/<\/(p|li|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendEmail(to, subject, htmlContent) {
  const fullHtml = wrapEmailDocument(htmlContent);
  const plainText = toPlainText(htmlContent);

  if (!EMAIL_ENABLED) {
    console.log('--- [E-mail simulado — defina BREVO_API_KEY e BREVO_SENDER_EMAIL pra enviar de verdade] ---');
    console.log(`Para: ${to}`);
    console.log(`Assunto: ${subject}`);
    console.log(plainText);
    console.log('------------------------------------------------------------------------------------------');
    return;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: EMAIL_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: fullHtml,
        textContent: plainText,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${body}`.trim());
    }

    // Log de sucesso: sem isso, um envio real (não-simulado) fica 100%
    // silencioso nos logs — e aí não dá pra distinguir, só olhando os logs,
    // entre "não tentou enviar" e "enviou com sucesso, mas não mostra nada".
    console.log(`[e-mail] enviado com sucesso para ${to} — assunto: "${subject}"`);
  } catch (err) {
    throw new Error(`Falha ao enviar e-mail via Brevo (${BREVO_SENDER_EMAIL}): ${err.message}`);
  }
}

// Avisa o Beauty Place (não o cliente) quando uma nova marcação chega pelo
// site público — assim não depende de ficar checando o painel /admin toda
// hora pra saber se tem gente esperando confirmação. Não depende de
// client_email (sempre roda) nem é afetada por ele; usa
// BUSINESS_NOTIFICATION_EMAIL (ou o próprio e-mail remetente, se essa
// variável não for definida).
async function notifyClinicNewBooking(booking, baseUrl) {
  if (!BUSINESS_NOTIFICATION_EMAIL) return;

  const subject = `Nova marcação pendente — ${booking.client_name}`;
  const html = `
    ${logoHeader(baseUrl)}
    <p>Nova marcação recebida pelo site, aguardando confirmação:</p>
    <ul>
      <li><strong>Cliente:</strong> ${escapeHtml(booking.client_name)}</li>
      <li><strong>Profissional:</strong> ${escapeHtml(booking.professional_name || '—')}</li>
      <li><strong>Telemóvel/WhatsApp:</strong> ${escapeHtml(booking.client_phone)}</li>
      <li><strong>Procedimento:</strong> ${escapeHtml(booking.service_name)}</li>
      <li><strong>Data:</strong> ${formatDateBR(booking.booking_date)} às ${escapeHtml(booking.booking_time)}</li>
    </ul>
    <p>Aceda ao painel administrativo para confirmar ou remarcar.</p>
  `;
  await sendEmail(BUSINESS_NOTIFICATION_EMAIL, subject, html);
}

async function notifyBookingCreatedEmail(booking, baseUrl) {
  if (!booking.client_email) return;

  const link = cancelLink(baseUrl, booking);
  const subject = 'Recebemos a sua marcação — Beauty Place';
  const html = `
    ${logoHeader(baseUrl)}
    <p>Olá, ${escapeHtml(booking.client_name)}! ✂️</p>
    <p>A sua marcação no <strong>Beauty Place</strong> foi recebida:</p>
    <ul>
      <li><strong>Profissional:</strong> ${escapeHtml(booking.professional_name || '—')}</li>
      <li><strong>Procedimento:</strong> ${escapeHtml(booking.service_name)}</li>
      <li><strong>Data:</strong> ${formatDateBR(booking.booking_date)}</li>
      <li><strong>Horário:</strong> ${escapeHtml(booking.booking_time)}</li>
    </ul>
    <p>Em breve confirmamos o seu horário por e-mail. Qualquer dúvida, basta responder a este e-mail ou contactar-nos.</p>
    ${link ? `<p>Se precisar de cancelar, <a href="${link}">clique aqui</a>.</p>` : ''}
    ${SPAM_NOTE}
    ${ADDRESS_NOTE}
  `;

  await sendEmail(booking.client_email, subject, html);
}

async function notifyStatusChangedEmail(booking, baseUrl) {
  if (!booking.client_email) return;

  if (booking.status === 'confirmado') {
    const link = cancelLink(baseUrl, booking);
    const subject = 'A sua marcação foi confirmada — Beauty Place';
    const html = `
      ${logoHeader(baseUrl)}
      <p>Olá, ${escapeHtml(booking.client_name)}! ✅</p>
      <p>A sua marcação no <strong>Beauty Place</strong> foi <strong>confirmada</strong>:</p>
      <ul>
        <li><strong>Profissional:</strong> ${escapeHtml(booking.professional_name || '—')}</li>
        <li><strong>Procedimento:</strong> ${escapeHtml(booking.service_name)}</li>
        <li><strong>Data:</strong> ${formatDateBR(booking.booking_date)} às ${escapeHtml(booking.booking_time)}</li>
      </ul>
      <p>Até lá!</p>
      ${link ? `<p>Se precisar de cancelar, <a href="${link}">clique aqui</a>.</p>` : ''}
      ${SPAM_NOTE}
    ${ADDRESS_NOTE}
    `;
    await sendEmail(booking.client_email, subject, html);
  } else if (booking.status === 'cancelado') {
    const subject = 'A sua marcação foi cancelada — Beauty Place';
    const html = `
      ${logoHeader(baseUrl)}
      <p>Olá, ${escapeHtml(booking.client_name)}.</p>
      <p>A sua marcação no <strong>Beauty Place</strong> do dia ${formatDateBR(booking.booking_date)} às ${escapeHtml(booking.booking_time)} foi <strong>cancelada</strong>.</p>
      <p>Para remarcar, basta aceder ao site novamente ou contactar-nos.</p>
      ${SPAM_NOTE}
    ${ADDRESS_NOTE}
    `;
    await sendEmail(booking.client_email, subject, html);
  }
}

async function notifyRescheduledEmail(booking, baseUrl) {
  if (!booking.client_email) return;

  const link = cancelLink(baseUrl, booking);
  const subject = 'A sua marcação foi remarcada — Beauty Place';
  const html = `
    ${logoHeader(baseUrl)}
    <p>Olá, ${escapeHtml(booking.client_name)}.</p>
    <p>A sua marcação no <strong>Beauty Place</strong> foi remarcada para:</p>
    <ul>
      <li><strong>Profissional:</strong> ${escapeHtml(booking.professional_name || '—')}</li>
      <li><strong>Procedimento:</strong> ${escapeHtml(booking.service_name)}</li>
      <li><strong>Nova data:</strong> ${formatDateBR(booking.booking_date)}</li>
      <li><strong>Novo horário:</strong> ${escapeHtml(booking.booking_time)}</li>
    </ul>
    <p>Qualquer dúvida, basta responder a este e-mail ou contactar-nos.</p>
    ${link ? `<p>Se precisar de cancelar, <a href="${link}">clique aqui</a>.</p>` : ''}
    ${SPAM_NOTE}
    ${ADDRESS_NOTE}
  `;
  await sendEmail(booking.client_email, subject, html);
}

async function notifyReminderEmail(booking, baseUrl) {
  if (!booking.client_email) return;

  const link = cancelLink(baseUrl, booking);
  const subject = 'Lembrete: a sua marcação é amanhã — Beauty Place';
  const html = `
    ${logoHeader(baseUrl)}
    <p>Olá, ${escapeHtml(booking.client_name)}! ⏰</p>
    <p>Lembramos que tem uma marcação <strong>amanhã</strong> no Beauty Place:</p>
    <ul>
      <li><strong>Profissional:</strong> ${escapeHtml(booking.professional_name || '—')}</li>
      <li><strong>Procedimento:</strong> ${escapeHtml(booking.service_name)}</li>
      <li><strong>Data:</strong> ${formatDateBR(booking.booking_date)}</li>
      <li><strong>Horário:</strong> ${escapeHtml(booking.booking_time)}</li>
    </ul>
    <p>Até lá! Se não puder comparecer, avise-nos com antecedência.</p>
    ${link ? `<p>Se precisar de cancelar, <a href="${link}">clique aqui</a>.</p>` : ''}
    ${SPAM_NOTE}
    ${ADDRESS_NOTE}
  `;
  await sendEmail(booking.client_email, subject, html);
}

module.exports = {
  notifyBookingCreatedEmail,
  notifyStatusChangedEmail,
  notifyRescheduledEmail,
  notifyReminderEmail,
  notifyClinicNewBooking,
  getEmailStatus,
};
