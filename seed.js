// Popula o banco com os profissionais, procedimentos e horário de
// funcionamento do Beauty Place (barbearia + cabeleireira, dentro do Holmes
// Place Braga). Rode com: npm run seed
//
// Horário de funcionamento definido em 23/10/2026 (seg-sáb, 09h-19h30
// corrido, domingo fechado) — "por agora", então pode mudar depois se o
// horário real do Isac e da Geuza acabar sendo diferente. Ajuste o array em
// defaultHours() abaixo quando precisar.
require('dotenv').config();
const { pool, initSchema } = require('./db');

const professionals = [
  { slug: 'isac', name: 'Isac', role: 'Barbeiro', sort_order: 1 },
  { slug: 'geuza', name: 'Geuza', role: 'Cabeleireira', sort_order: 2 },
];

// Preços e durações coletados do site atual (beautyplace.pt) em 23/10/2026 e
// revisados em 27/10/2026 após auditoria completa das 3 abas de serviços
// (Homem, Mulher, Prótese Capilar). Correções feitas na revisão:
// - Descoloração, Alisamento Masculino e Limpeza Facial estavam atribuídos à
//   Geuza por engano — no site real ficam na aba "Homem", ou seja, são do
//   Isac. Movidos para a lista dele.
// - Adicionados os serviços da aba "Mulher" (todos da Geuza) e da aba
//   "Prótese Capilar" (todos do Isac, confirmado com o cliente).
// price_cents = preço em cêntimos (€13,00 = 1300). Serviços com preço "a
// partir de" no site original usam o valor mínimo informado — o nome do
// serviço deixa isso explícito pro cliente ver na hora de marcar.
const servicesByProfessional = {
  isac: [
    { name: 'Barba', duration_minutes: 30, price_cents: 1300 },
    { name: 'Corte Masculino', duration_minutes: 40, price_cents: 1600 },
    { name: 'Corte e Barba', duration_minutes: 60, price_cents: 2300 },
    { name: 'Corte Infantil Masculino', duration_minutes: 40, price_cents: 1600 },
    { name: 'Contornos', duration_minutes: 60, price_cents: 500 },
    { name: 'VIP - Corte, Barba, Sobrancelha e Limpeza Facial', duration_minutes: 70, price_cents: 3800 },
    { name: 'Descoloração', duration_minutes: 120, price_cents: 5000 },
    { name: 'Alisamento Masculino', duration_minutes: 60, price_cents: 3000 },
    { name: 'Limpeza Facial', duration_minutes: 15, price_cents: 1500 },
    { name: 'Avaliação para Prótese Capilar', duration_minutes: 60, price_cents: 0 },
    { name: 'Aplicação de Prótese Capilar (a partir de)', duration_minutes: 60, price_cents: 35000 },
    { name: 'Manutenção de Prótese Capilar', duration_minutes: 90, price_cents: 5000 },
  ],
  geuza: [
    { name: 'Brushing - Somente Secar (a partir de)', duration_minutes: 60, price_cents: 1200 },
    { name: 'Brushing - Lavar e Secar (a partir de)', duration_minutes: 60, price_cents: 1500 },
    { name: 'Corte e Brushing (a partir de)', duration_minutes: 60, price_cents: 2500 },
    { name: 'Alisamento - Progressiva (a partir de)', duration_minutes: 150, price_cents: 8000 },
    { name: 'Tratamento (a partir de)', duration_minutes: 90, price_cents: 3500 },
    { name: 'Coloração (a partir de)', duration_minutes: 60, price_cents: 3500 },
    { name: 'Madeixas (a partir de)', duration_minutes: 180, price_cents: 10000 },
    { name: 'Sobrancelha', duration_minutes: 20, price_cents: 800 },
  ],
};

// Horário atual: segunda a sábado, 09h-19h30 corrido, domingo fechado.
// Mesmo horário pros dois profissionais por enquanto — ajuste cada um
// separadamente aqui se precisar diferenciar depois.
function defaultHours() {
  return [
    { weekday: 0, open_time: null, close_time: null, open_time2: null, close_time2: null, closed: 1 }, // domingo
    { weekday: 1, open_time: '09:00', close_time: '19:30', open_time2: null, close_time2: null, closed: 0 },
    { weekday: 2, open_time: '09:00', close_time: '19:30', open_time2: null, close_time2: null, closed: 0 },
    { weekday: 3, open_time: '09:00', close_time: '19:30', open_time2: null, close_time2: null, closed: 0 },
    { weekday: 4, open_time: '09:00', close_time: '19:30', open_time2: null, close_time2: null, closed: 0 },
    { weekday: 5, open_time: '09:00', close_time: '19:30', open_time2: null, close_time2: null, closed: 0 },
    { weekday: 6, open_time: '09:00', close_time: '19:30', open_time2: null, close_time2: null, closed: 0 }, // sábado
  ];
}

async function main() {
  await initSchema();

  const professionalIds = {};
  for (const p of professionals) {
    const { rows } = await pool.query(
      `INSERT INTO professionals (slug, name, role, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, sort_order = EXCLUDED.sort_order
       RETURNING id`,
      [p.slug, p.name, p.role, p.sort_order]
    );
    professionalIds[p.slug] = rows[0].id;
  }
  console.log(`Profissionais: ${professionals.map((p) => `${p.name} (${p.role})`).join(', ')}`);

  // Correção de categorização (27/10/2026): Descoloração, Alisamento e Limpeza
  // Facial foram cadastrados por engano na Geuza numa versão anterior do seed.
  // Se o banco já tiver rodado essa versão antiga, remove as linhas erradas da
  // Geuza antes de inserir a versão certa (Isac) — evita duplicar o serviço
  // nos dois profissionais.
  const { rowCount: removidos } = await pool.query(
    `DELETE FROM services WHERE professional_id = $1 AND name IN ('Descoloração', 'Alisamento', 'Limpeza Facial')`,
    [professionalIds.geuza]
  );
  if (removidos > 0) {
    console.log(`Correção: removido(s) ${removidos} serviço(s) mal categorizado(s) da Geuza (pertenciam ao Isac).`);
  }

  let updated = 0;
  let inserted = 0;
  for (const [slug, services] of Object.entries(servicesByProfessional)) {
    const professionalId = professionalIds[slug];
    for (const s of services) {
      const { rowCount } = await pool.query(
        'UPDATE services SET duration_minutes = $1, price_cents = $2 WHERE name = $3 AND professional_id = $4',
        [s.duration_minutes, s.price_cents, s.name, professionalId]
      );
      if (rowCount > 0) {
        updated++;
      } else {
        await pool.query(
          'INSERT INTO services (professional_id, name, duration_minutes, price_cents) VALUES ($1, $2, $3, $4)',
          [professionalId, s.name, s.duration_minutes, s.price_cents]
        );
        inserted++;
      }
    }
  }
  console.log(`Procedimentos: ${updated} atualizado(s), ${inserted} novo(s) inserido(s).`);

  for (const slug of Object.keys(professionalIds)) {
    const professionalId = professionalIds[slug];
    for (const h of defaultHours()) {
      await pool.query(
        `INSERT INTO business_hours (professional_id, weekday, open_time, close_time, open_time2, close_time2, closed)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (professional_id, weekday) DO UPDATE SET
           open_time = EXCLUDED.open_time,
           close_time = EXCLUDED.close_time,
           open_time2 = EXCLUDED.open_time2,
           close_time2 = EXCLUDED.close_time2,
           closed = EXCLUDED.closed`,
        [professionalId, h.weekday, h.open_time, h.close_time, h.open_time2, h.close_time2, h.closed]
      );
    }
  }
  console.log('Horário de funcionamento configurado (seg-sáb 09h-19h30, dom fechado) pros dois profissionais.');

  await pool.end();
}

main().catch((err) => {
  console.error('Erro ao rodar o seed:', err.message);
  process.exit(1);
});
