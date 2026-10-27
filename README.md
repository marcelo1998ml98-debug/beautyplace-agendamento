# Beauty Place — Agendamento

Plataforma de agendamento online para o **Beauty Place** (barbearia com o **Isac** e cabeleireiro com a **Geuza**), dentro do Holmes Place Braga. Página pública para clientes marcarem procedimentos — sem precisar criar conta — e painel administrativo para o Beauty Place visualizar e confirmar as marcações. Base derivada do mesmo projeto usado para a Santé Estética Integrada, adaptada para suportar **dois profissionais com agendas independentes** dentro de uma única plataforma.

## O que já está pronto

- Página pública (`/`) com a identidade visual do Beauty Place (tema escuro/dourado, tipografia serifada), seletor de profissional (Isac ou Geuza — cada um com a sua lista de procedimentos e disponibilidade própria) e formulário de marcação com seleção de data/horário disponível em tempo real. **Não exige cadastro/login do cliente.**
- Duas agendas totalmente **independentes** dentro da mesma plataforma: marcações, bloqueios e horário de funcionamento de um profissional nunca afetam a disponibilidade do outro. Um bloqueio pode valer só para um profissional (ex: dia de folga) ou para o espaço inteiro (ex: feriado, fechamento do Holmes Place) — ver seção "Marcação manual, remarcação e bloqueios de agenda" abaixo.
- Painel administrativo (`/admin`) protegido por senha, onde o Beauty Place:
  - vê todas as marcações dos dois profissionais numa lista só, com filtro por **profissional** e por **status**, além de busca por nome/telemóvel;
  - confirma, cancela ou marca como concluída cada marcação;
  - cria uma **marcação manual** (ex: cliente que pergunta horário disponível pelo telemóvel/WhatsApp) pelo botão "+ Nova marcação" — escolhe o profissional, o procedimento correspondente já aparece filtrado, e a marcação já entra confirmada;
  - **remarca** (troca data/horário) uma marcação existente sem precisar cancelar e recriar;
  - **bloqueia um dia inteiro ou um intervalo de horário** na agenda — de um profissional específico ou do espaço inteiro — impedindo novas marcações nesse período;
  - vê, logo no topo, três **cartões de resumo** (Hoje / Amanhã / Pendentes) somando os dois profissionais.
- **Aviso automático** por e-mail toda vez que uma marcação nova chega pelo site — veja a seção "Aviso de nova marcação" abaixo.
- **Prévia de link (Open Graph)** com imagem, título e descrição ao compartilhar o site no WhatsApp/Instagram/Facebook — veja a seção "Prévia do link" abaixo.
- Banco de dados Postgres (ex: o gratuito do Supabase) — os dados não se perdem quando o servidor reinicia, mesmo em hospedagem com disco temporário.
- Lógica de disponibilidade que respeita o horário de funcionamento de cada profissional — incluindo dois turnos no mesmo dia, se necessário — evita marcações sobrepostas e também respeita os bloqueios de agenda.
- Confirmação automática por **e-mail** para o cliente (enviado via Brevo) quando a marcação é criada, confirmada, cancelada ou remarcada — veja a seção "E-mail de confirmação" abaixo.
- **Lembrete automático** por e-mail (e WhatsApp, quando ativado) um dia antes da marcação confirmada — veja a seção "Lembrete automático" abaixo.
- **Cliente cancela a própria marcação** por um link único que vem no e-mail de confirmação, sem precisar ligar para o espaço.
- Módulo de WhatsApp (`whatsapp.js`) com a integração real via Baileys pronta — fica disponível para ativar quando houver um número dedicado só para isso. Por padrão roda em modo simulado (`WHATSAPP_ENABLED=false`), só mostrando no terminal o que seria enviado; veja a seção "Conectando o WhatsApp de verdade" abaixo para ativar de vez.

## ⚠️ Pendências antes de ir ao ar

- **Horário de funcionamento**: seg-sáb 09h-19h30 corrido, domingo fechado, igual para o Isac e a Geuza — definido em 23/10/2026, "por agora" (pode mudar). Para ajustar, edite `defaultHours()` em `seed.js` e rode `npm run seed` novamente.
- **Domínio de produção ainda não existe** — `FALLBACK_DOMAIN` em `email.js`, a URL de exemplo no cron (seção "Lembrete automático") e as tags Open Graph em `index.html` usam `beautyplace-agendamento.onrender.com` como placeholder, assumindo esse nome pro serviço no Render. Atualize essas três referências se o nome do serviço acabar sendo outro.
- **Logo**: já reproduzido em texto/imagem (wordmark "[ beauty place ] for gym") a partir do logo real enviado pelo cliente — ver `public/img/icon.png`, `public/img/og-image.jpg` e `public/img/logo-email.png`. Se o cliente tiver o arquivo original em alta resolução (vetor ou PNG grande), vale substituir esses três arquivos pelo original pra mais nitidez.
- **Fotos reais do espaço** ainda não existem — o hero do site usa só um gradiente (CSS), sem foto de fundo. Quando houver fotos reais, pode-se adicionar uma imagem de fundo no hero em `index.html`/`style.css`.

## Banco de dados (Supabase)

Esse projeto usa Postgres. A forma mais simples e gratuita de ter um é o [Supabase](https://supabase.com):

1. Crie uma conta grátis em [supabase.com](https://supabase.com) e um novo projeto (escolha uma senha forte para o banco quando pedir — guarde ela).
2. No painel do projeto, vá em **Project Settings → Database → Connection string** e copie a opção **"Connection pooling"** (modo "Transaction", porta 6543) — é a recomendada para conectar de fora do Supabase.
3. Essa string vira o valor de `DATABASE_URL` (veja a seção "Configuração" abaixo).

O projeto cria automaticamente (na primeira vez que o servidor ou o `npm run seed` rodarem) as tabelas `professionals`, `services`, `bookings`, `business_hours` e `blocked_periods`.

## Como rodar localmente

```bash
npm install
cp .env.example .env   # preencha ADMIN_PASSWORD, SESSION_SECRET e DATABASE_URL antes de seguir — veja a seção de configuração abaixo
npm run seed      # cria as tabelas e popula os profissionais, procedimentos e horário de funcionamento (idempotente, pode rodar de novo sem duplicar)
npm start
```

O servidor sobe em `http://localhost:3000`. O painel administrativo fica em `http://localhost:3000/admin`, com a senha que você definiu em `ADMIN_PASSWORD`.

**Importante:** `ADMIN_PASSWORD` e `SESSION_SECRET` são obrigatórias — não existe valor de reserva para essas duas (de propósito, para evitar que alguém esqueça de trocar a senha padrão em produção). O servidor recusa iniciar sem as duas definidas.

## Configuração

Copie `.env.example` para `.env` e ajuste:

```bash
cp .env.example .env
```

- `DATABASE_URL`: a string de conexão do Supabase (veja a seção "Banco de dados" acima). Obrigatória — sem ela o servidor não sobe.
- `ADMIN_PASSWORD`: senha de acesso ao painel. Obrigatória, sem valor padrão — gere uma senha forte (ex: `openssl rand -base64 18`).
- `SESSION_SECRET`: segredo usado para assinar o cookie de login do admin. Obrigatória, sem valor padrão — gere um valor aleatório (ex: `openssl rand -base64 32`).
- `WHATSAPP_ENABLED`: deixe `false` enquanto estiver testando. Quando a integração com Baileys estiver conectada, mude para `true`.
- `BREVO_API_KEY` e `BREVO_SENDER_EMAIL`: credenciais da conta Brevo para enviar o e-mail de confirmação de verdade (veja a seção abaixo). Sem elas, roda em modo simulado.
- `CRON_SECRET`: token secreto que protege o lembrete automático (veja a seção "Lembrete automático" abaixo). No Render, essa variável já vem com um valor aleatório gerado automaticamente — só copiar o valor de lá para montar a URL do cron externo.
- `DATABASE_SSL_REJECT_UNAUTHORIZED`: opcional (`true`/`false`). Valida de verdade o certificado TLS da conexão com o Postgres — teste antes de ativar em produção.
- `BUSINESS_NOTIFICATION_EMAIL`: opcional. E-mail que recebe o aviso de nova marcação (ver seção abaixo). Sem isso, usa `BREVO_SENDER_EMAIL`.
- `BUSINESS_ADDRESS`: opcional. Endereço exibido no rodapé dos e-mails (ajuda contra spam — ver seção "E-mail de confirmação"). Já tem um valor padrão (Holmes Place Braga).

## E-mail de confirmação

O cliente recebe um e-mail automático quando a marcação é criada, confirmada, cancelada ou remarcada, enviado via **Brevo** (serviço terceiro de envio de e-mail, usado pela API HTTP). Para ativar de vez:

1. Crie uma conta gratuita em [brevo.com](https://www.brevo.com) (o plano grátis permite até 300 e-mails/dia).
2. Em Configurações → SMTP & API → API Keys, gere uma **API key**.
3. Defina duas variáveis de ambiente:
   - `BREVO_API_KEY`: a API key gerada no passo 2.
   - `BREVO_SENDER_EMAIL`: o e-mail que vai aparecer como remetente (ex: `contato.beautyplace@outlook.com`) — precisa estar verificado na conta Brevo (ela manda um e-mail de confirmação para esse endereço na hora de cadastrar).
4. Reinicie o servidor (ou redeploy, se já estiver no Render). Os e-mails passam a ser enviados de verdade.

Enquanto essas duas variáveis não estiverem configuradas, o sistema roda em modo simulado: o e-mail que seria enviado só aparece no console/log do servidor, sem interromper o funcionamento do site.

Por que via Brevo e não direto por uma conta de e-mail comum (Outlook/Gmail, via SMTP)? O envio direto tende a cair menos no spam, mas usa a porta SMTP 587, e o **plano gratuito do Render bloqueia portas de SMTP** — então, enquanto o serviço estiver no plano grátis, só funciona por uma API HTTP, como a do Brevo. Isso significa que o aviso de "confira a caixa de spam" ainda é relevante, já que o remetente provavelmente será um e-mail de domínio gratuito, não um domínio próprio do Beauty Place. Se no futuro quiserem resolver isso de forma mais definitiva, as duas opções são: (a) comprar um domínio próprio e configurar SPF/DKIM para ele no Brevo, ou (b) fazer upgrade do serviço web no Render para o plano pago (a partir de US$ 7/mês) e usar o envio direto por SMTP.

Dois ajustes de graça que já ajudam um pouco e já estão implementados: todo e-mail sai com uma versão em texto puro além do HTML, e o rodapé mostra o endereço físico quando `BUSINESS_ADDRESS` estiver configurado.

## Aviso de nova marcação

Além do e-mail que o cliente recebe, o Beauty Place também recebe um e-mail automático (`BUSINESS_NOTIFICATION_EMAIL`) toda vez que uma marcação nova chega pelo site público — assim não é preciso ficar checando o painel o tempo todo. Se essa variável não for definida, usa o mesmo endereço de `BREVO_SENDER_EMAIL`. Marcações feitas manualmente pelo próprio painel admin não disparam esse aviso.

## Prévia do link (Open Graph)

Quando alguém colar o link do site no WhatsApp, Instagram ou Facebook, aparece uma prévia com imagem, título e descrição — configurado via tags Open Graph/Twitter Card em `public/index.html`, usando a imagem `public/img/og-image.jpg` (placeholder — ver seção "Pendências" acima). Se o domínio mudar no futuro, atualize as URLs absolutas nas tags `og:url`/`og:image`/`twitter:image` em `index.html`.

## Lembrete automático

Todo dia, o sistema pode mandar um lembrete por e-mail (e WhatsApp, se estiver ativado) para os clientes com marcação **confirmada para o dia seguinte**. Isso roda através de um endpoint (`/api/cron/send-reminders`) que precisa ser "tocado" uma vez por dia — o Render gratuito não tem um agendador (cron) embutido de graça, então usamos um serviço externo gratuito só para isso:

1. Pegue o valor de `CRON_SECRET` nas variáveis de ambiente do Render (Environment → `CRON_SECRET` — foi gerado automaticamente no deploy).
2. Crie uma conta grátis em [cron-job.org](https://cron-job.org).
3. Crie um novo cron job com:
   - **URL**: `https://beautyplace-agendamento.onrender.com/api/cron/send-reminders?token=COLE_O_CRON_SECRET_AQUI` (ajuste o domínio se o nome do serviço no Render for outro)
   - **Execução**: uma vez por dia, no fim da tarde/noite (ex: 18h) — assim já pega as marcações confirmadas para o dia seguinte com folga.
4. Salve. Pronto — todo dia nesse horário, o cron-job.org acessa essa URL, o servidor confere quem tem marcação confirmada para amanhã e ainda não recebeu lembrete, e manda o e-mail (e WhatsApp, se ativado) automaticamente.

Cada marcação só recebe um lembrete. Se não configurar isso, o resto do sistema funciona normalmente — só não vai ter lembrete automático.

## Marcação manual, remarcação e bloqueios de agenda

No painel admin:

- **+ Nova marcação**: escolhe o profissional, depois o procedimento (já filtrado para esse profissional), data e horário — mesmo fluxo do site público, só que a marcação já entra como confirmada.
- **Remarcar** (em cada marcação da lista, exceto as já canceladas/concluídas): abre um seletor de nova data/horário, considerando a disponibilidade real daquele mesmo profissional (sem contar a própria marcação como "ocupada"). O cliente recebe um aviso da nova data por e-mail/WhatsApp.
- **Bloqueios de agenda** (seção no fim do painel): escolha "Todo o espaço" para um bloqueio que vale para os dois profissionais (ex: feriado, fechamento do Holmes Place) ou um profissional específico (ex: folga pessoal) — bloqueando um dia inteiro (deixe início/fim em branco) ou só um intervalo específico, com um motivo opcional. Marcações que já existiam nesse horário **não são afetadas** (o bloqueio só impede marcações *novas*). Para liberar de novo, é só clicar em "Remover" na lista de bloqueios.

## Cliente cancela a própria marcação

O e-mail de confirmação (e o de "marcação confirmada") vem com um link único de cancelamento. O cliente clica, vê os dados da marcação e confirma o cancelamento numa página simples — sem precisar ligar ou mandar mensagem. O cancelamento aparece refletido no painel admin em segundos.

## Conectando o WhatsApp de verdade

O `whatsapp.js` já tem a integração real pronta (Baileys + QR code). Para ativar:

1. `npm install` (já inclui `@whiskeysockets/baileys`, `qrcode-terminal` e `@hapi/boom`).
2. No `.env`, defina `WHATSAPP_ENABLED=true`.
3. Rode `npm start`. Vai aparecer um QR code no terminal.
4. No telemóvel do Beauty Place: **WhatsApp > Aparelhos conectados > Conectar aparelho** e leia o QR code.
5. Pronto. A sessão fica salva em `data/auth/` (nunca suba essa pasta para o GitHub — ela já está no `.gitignore`). Nas próximas vezes que o servidor subir, ele reconecta sozinho, sem pedir QR code de novo.

Recomendado usar um número de WhatsApp dedicado só para isso, porque enquanto o bot estiver conectado, não dá para também ter o WhatsApp Web/Desktop aberto nesse mesmo número ao mesmo tempo.

No painel admin (`/admin`), tem um indicador no topo mostrando se o WhatsApp está conectado, aguardando QR code, ou desconectado.

Se o WhatsApp cair ou travar: pare o servidor, apague a pasta `data/auth/` e suba de novo — vai pedir para ler o QR code mais uma vez.

## Colocando no ar (deploy gratuito)

Esse projeto já vem com um `render.yaml` (Blueprint do Render) pronto — ele configura sozinho o build command, o start command e as variáveis de ambiente.

1. **Suba este projeto para o GitHub** (sem precisar usar linha de comando):
   - Crie uma conta grátis em [github.com](https://github.com) (se ainda não tiver uma).
   - Clique em "New repository", dê um nome (ex: `beautyplace-agendamento`) e deixe como **privado** ou público, como preferir. Não marque "Add a README".
   - Na página do repositório recém-criado, clique em "uploading an existing file" e arraste a pasta inteira do projeto (todos os arquivos, exceto `node_modules` e `data`) para dentro da janela do navegador. Clique em "Commit changes".
2. **Crie uma conta grátis em [render.com](https://render.com)** e conecte sua conta do GitHub a ele.
3. No painel do Render, clique em **"New +" → "Blueprint"**, selecione o repositório que você acabou de criar. O Render vai ler o `render.yaml` sozinho e já deixar o serviço configurado.
4. Vai pedir o valor de algumas variáveis: `ADMIN_PASSWORD`, `DATABASE_URL`, `BREVO_API_KEY` e `BREVO_SENDER_EMAIL` (pode deixar em branco por enquanto, os e-mails ficam em modo simulado até lá). As demais (`SESSION_SECRET`, `WHATSAPP_ENABLED`, `CRON_SECRET`) já vêm preenchidas automaticamente.
5. Clique em "Apply"/"Deploy". Em 1-2 minutos o Render dá um link fixo tipo `https://beautyplace-agendamento.onrender.com` (se o nome do serviço for outro, o link muda de acordo) — esse é o link para compartilhar com o Isac e a Geuza.

Importante sobre o plano gratuito do Render: o serviço "dorme" depois de um tempo sem acesso, e a primeira requisição depois disso demora uns 50 segundos para responder. Como os dados ficam no Supabase, eles **não se perdem** quando isso acontece.

Sobre o Supabase gratuito: o projeto "pausa" se ficar 7 dias seguidos sem nenhum acesso (reativa com 1 clique no painel do Supabase, sem perder dados).

## Segurança

Esse projeto passou por uma rodada de revisão de segurança (auditoria de código-fonte) ainda no projeto-base (Santé). Resumo do que foi corrigido e se mantém aqui:

- **Sem senha/segredo padrão de fábrica**: `ADMIN_PASSWORD` e `SESSION_SECRET` não têm valor de reserva — o servidor recusa iniciar sem os dois configurados.
- **Validação de data/horário**: os campos `booking_date`/`booking_time` são validados no servidor contra o formato esperado.
- **Escape de HTML nos e-mails**: todo dado do cliente é escapado antes de entrar no HTML do e-mail, prevenindo injeção de HTML/script.
- **Marcação pendente não trava o horário para sempre**: uma marcação "pendente" só segura o horário pelos primeiros 15 minutos.
- **Comparação em tempo constante**: a senha do admin e o token do cron são comparados de um jeito que não vaza informação por tempo de resposta.
- **TLS do banco**: opção (`DATABASE_SSL_REJECT_UNAUTHORIZED`) para validar de verdade o certificado da conexão com o Postgres.

## Próximos passos sugeridos

- Resolver as pendências listadas no topo deste README (horário real, domínio definitivo, logo/fotos reais) antes de divulgar o link para clientes.
- Configurar o lembrete automático (seção acima) para reduzir falta/esquecimento de clientes.
- Garantir que a pasta `data/auth/` (sessão do WhatsApp) fique num disco persistente no hosting escolhido, se/quando o WhatsApp de verdade for ativado.
