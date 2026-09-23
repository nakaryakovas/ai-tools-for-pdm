const slotsEl = document.getElementById('slots');
const dateEl = document.getElementById('walk-date');
const feedingInfoEl = document.getElementById('feeding-info');
const feedingForm = document.getElementById('feeding-form');
const feedingNameInput = document.getElementById('feeding-name');
const messageEl = document.getElementById('message');

function showMessage(text, kind) {
  messageEl.textContent = text;
  messageEl.className = 'message' + (kind ? ' ' + kind : '');
}

function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function render(state) {
  dateEl.textContent = formatDate(state.walkDate);

  if (state.lastFeeding) {
    feedingInfoEl.textContent =
      `${state.lastFeeding.employee_name} · ${formatDateTime(state.lastFeeding.fed_at)}`;
  } else {
    feedingInfoEl.textContent = 'Данных пока нет — покормите Бориса!';
  }

  slotsEl.innerHTML = '';
  for (const slot of state.slots) {
    const card = document.createElement('div');
    card.className = 'slot ' + (slot.booked_by ? 'busy' : 'free');

    const info = document.createElement('div');
    info.className = 'slot-info';

    const time = document.createElement('div');
    time.className = 'slot-time';
    time.textContent = slot.slot_time;

    const status = document.createElement('div');
    status.className = 'slot-status';

    if (slot.booked_by) {
      status.textContent = 'Занято: ' + slot.booked_by;
      info.append(time, status);
      card.append(info);
      card.title = 'Слот занят';
      card.addEventListener('click', () => {
        showMessage(
          'К сожалению, данное время для выгула Бориса уже занято, выберите другое время',
          'error'
        );
      });
    } else {
      status.textContent = 'Свободно';
      info.append(time, status);
      const form = document.createElement('form');
      form.className = 'inline-form';
      const label = document.createElement('label');
      label.textContent = 'ФИО';
      label.htmlFor = 'walk-name-' + slot.slot_time.replace(':', '-');
      const input = document.createElement('input');
      input.type = 'text';
      input.id = label.htmlFor;
      input.maxLength = 100;
      input.required = true;
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = 'Записаться';
      form.append(label, input, button);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        book(slot.slot_time, input.value);
      });
      card.append(info, form);
    }

    slotsEl.append(card);
  }
}

async function loadState() {
  const res = await fetch('/api/state');
  render(await res.json());
}

async function book(slotTime, name) {
  showMessage('');
  try {
    const res = await fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotTime, name }),
    });
    const data = await res.json();
    if (res.ok) {
      showMessage(`Готово! Слот ${slotTime} занят.`, 'success');
      render(data.state);
    } else {
      showMessage(data.error || 'Не удалось записаться', 'error');
      if (data.state) render(data.state);
    }
  } catch {
    showMessage('Ошибка связи с сервером', 'error');
  }
}

feedingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('');
  const name = feedingNameInput.value;
  try {
    const res = await fetch('/api/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok) {
      feedingNameInput.value = '';
      showMessage('Кормление отмечено. Спасибо за Бориса!', 'success');
      render(data.state);
    } else {
      showMessage(data.error || 'Не удалось отметить кормление', 'error');
    }
  } catch {
    showMessage('Ошибка связи с сервером', 'error');
  }
});

loadState();
