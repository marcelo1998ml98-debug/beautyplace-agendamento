// Tema claro/escuro — lembra a escolha de cada visitante no navegador dele
// (não é algo que precise sincronizar entre dispositivos ou com o admin).
(function initThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  let saved = null;
  try { saved = localStorage.getItem('bp-theme'); } catch (e) { /* navegador privado etc. */ }
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  }

  toggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('bp-theme', next); } catch (e) { /* ignora se não der pra salvar */ }
  });
})();

const professionalPicker = document.getElementById('professional-picker');
const serviceSelect = document.getElementById('service-select');
const dateInput = document.getElementById('date-input');
const dateDisplayText = document.getElementById('date-display-text');
const slotsContainer = document.getElementById('slots-container');
const nameInput = document.getElementById('client-name');
const phoneInput = document.getElementById('client-phone');
const emailInput = document.getElementById('client-email');
const notesInput = document.getElementById('client-notes');
const submitBtn = document.getElementById('submit-btn');
const msgBox = document.getElementById('msg-box');
const proceduresList = document.getElementById('procedures-list');

let professionals = [];
let services = [];
let selectedProfessionalId = null;
let selectedTime = null;

// Data mínima = hoje
const today = new Date().toISOString().slice(0, 10);
dateInput.min = today;
dateInput.value = today;

// Mostra a data (formato dd/mm/aaaa) na caixinha decorativa por cima do
// input de verdade, que fica invisível — ver comentário em style.css.
function updateDateDisplay() {
  const [y, m, d] = dateInput.value.split('-');
  dateDisplayText.textContent = (y && m && d) ? `${d}/${m}/${y}` : '';
}
updateDateDisplay();
dateInput.addEventListener('input', updateDateDisplay);

function showMsg(text, type) {
  msgBox.textContent = text;
  msgBox.className = `msg show ${type}`;
}

function clearMsg() {
  msgBox.className = 'msg';
}

function formatPrice(cents) {
  if (cents === null || cents === undefined) return '';
  return `€${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function updateSubmitState() {
  const ok = selectedProfessionalId && serviceSelect.value && dateInput.value && selectedTime &&
    nameInput.value.trim() && phoneInput.value.trim() &&
    emailInput.value.trim() && emailInput.checkValidity();
  submitBtn.disabled = !ok;
}

async function loadProfessionals() {
  const res = await fetch('/api/professionals');
  professionals = await res.json();

  professionalPicker.innerHTML = professionals.map((p) => `
    <button type="button" class="professional-pill" data-id="${p.id}">
      <span class="professional-pill__name">${p.name}</span>
      <span class="professional-pill__role">${p.role}</span>
    </button>
  `).join('');

  professionalPicker.querySelectorAll('.professional-pill').forEach((btn) => {
    btn.addEventListener('click', () => selectProfessional(Number(btn.dataset.id)));
  });

  // Com só um profissional ativo, já seleciona ele direto — não faz sentido
  // pedir pra escolher quando não há escolha.
  if (professionals.length === 1) {
    selectProfessional(professionals[0].id);
  }
}

async function selectProfessional(id) {
  selectedProfessionalId = id;
  selectedTime = null;

  professionalPicker.querySelectorAll('.professional-pill').forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.id) === id);
  });

  serviceSelect.disabled = false;
  serviceSelect.innerHTML = '<option value="">Carregando procedimentos...</option>';
  await loadServices(id);
  loadSlots();
  updateSubmitState();
}

async function loadServices(professionalId) {
  const res = await fetch(`/api/services?professional_id=${professionalId}`);
  services = await res.json();

  serviceSelect.innerHTML = '<option value="">Selecione um procedimento</option>' +
    services.map((s) => `<option value="${s.id}">${s.name} (${s.duration_minutes} min)${s.price_cents ? ' — ' + formatPrice(s.price_cents) : ''}</option>`).join('');

  proceduresList.innerHTML = services.map((s) => `
    <div class="procedure-row">
      <span class="procedure-row__name"><span class="procedure-row__dot"></span>${s.name}</span>
      <span class="procedure-row__price">${formatPrice(s.price_cents)}</span>
    </div>
  `).join('');
}

async function loadSlots() {
  selectedTime = null;
  updateSubmitState();

  const serviceId = serviceSelect.value;
  const date = dateInput.value;

  if (!selectedProfessionalId) {
    slotsContainer.innerHTML = '<span class="slots-empty">Selecione o profissional acima.</span>';
    return;
  }
  if (!serviceId || !date) {
    slotsContainer.innerHTML = '<span class="slots-empty">Selecione o procedimento e a data acima.</span>';
    return;
  }

  slotsContainer.innerHTML = '<span class="slots-empty">Carregando horários...</span>';

  const res = await fetch(`/api/availability?date=${date}&service_id=${serviceId}`);
  const data = await res.json();

  if (!data.slots || data.slots.length === 0) {
    slotsContainer.innerHTML = '<span class="slots-empty">Nenhum horário disponível nessa data. Tente outro dia.</span>';
    return;
  }

  slotsContainer.innerHTML = '';
  data.slots.forEach((slot) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn';
    btn.textContent = slot;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.slot-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedTime = slot;
      updateSubmitState();
    });
    slotsContainer.appendChild(btn);
  });
}

serviceSelect.addEventListener('change', loadSlots);
dateInput.addEventListener('change', loadSlots);
nameInput.addEventListener('input', updateSubmitState);
phoneInput.addEventListener('input', updateSubmitState);
emailInput.addEventListener('input', updateSubmitState);

submitBtn.addEventListener('click', async () => {
  clearMsg();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Enviando...';

  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: serviceSelect.value,
        client_name: nameInput.value.trim(),
        client_phone: phoneInput.value.trim(),
        client_email: emailInput.value.trim(),
        booking_date: dateInput.value,
        booking_time: selectedTime,
        notes: notesInput.value.trim(),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMsg(data.error || 'Não foi possível concluir a marcação.', 'error');
      if (res.status === 409) await loadSlots(); // horário foi ocupado por outra pessoa, recarrega
      submitBtn.textContent = 'Confirmar marcação';
      updateSubmitState();
      return;
    }

    showMsg('Marcação recebida! Vai receber uma confirmação por e-mail em breve (dê uma vista de olhos na caixa de spam, caso não encontre).', 'success');
    nameInput.value = '';
    phoneInput.value = '';
    emailInput.value = '';
    notesInput.value = '';
    selectedTime = null;
    await loadSlots();
    submitBtn.textContent = 'Confirmar marcação';
  } catch (err) {
    showMsg('Erro de ligação. Tente novamente.', 'error');
    submitBtn.textContent = 'Confirmar marcação';
    updateSubmitState();
  }
});

loadProfessionals();
