const tabCreate = document.getElementById('tabCreate');
const tabJoin = document.getElementById('tabJoin');
const createForm = document.getElementById('createForm');
const joinForm = document.getElementById('joinForm');

// If a QR code deep-linked here with ?code=..., jump straight to the join tab.
const params = new URLSearchParams(location.search);
if (params.get('code')) {
  document.getElementById('joinCode').value = params.get('code');
}

tabCreate.addEventListener('click', () => {
  tabCreate.classList.add('active');
  tabJoin.classList.remove('active');
  createForm.style.display = 'block';
  joinForm.style.display = 'none';
});
tabJoin.addEventListener('click', () => {
  tabJoin.classList.add('active');
  tabCreate.classList.remove('active');
  joinForm.style.display = 'block';
  createForm.style.display = 'none';
});
if (params.get('code')) tabJoin.click();

function showError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.style.display = 'block';
}

createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const hostName = document.getElementById('createName').value.trim();
  const password = document.getElementById('createPassword').value;
  document.getElementById('createError').style.display = 'none';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create room');

    sessionStorage.setItem('syncsound:name', hostName);
    sessionStorage.setItem(`syncsound:hostToken:${data.code}`, data.hostToken);
    location.href = `/room.html?code=${encodeURIComponent(data.code)}`;
  } catch (err) {
    showError('createError', err.message);
  }
});

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('joinName').value.trim();
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const password = document.getElementById('joinPassword').value;
  document.getElementById('joinError').style.display = 'none';

  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Room not found');

    sessionStorage.setItem('syncsound:name', name);
    if (password) sessionStorage.setItem('syncsound:joinPassword', password);
    location.href = `/room.html?code=${encodeURIComponent(code)}`;
  } catch (err) {
    showError('joinError', err.message);
  }
});
