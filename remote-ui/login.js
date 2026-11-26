const password = document.getElementById('password');
const toggle = document.getElementById('toggle-password');
toggle.hidden = false;
toggle.addEventListener('click', () => {
  const reveal = password.type === 'password';
  const label = reveal ? toggle.dataset.hide : toggle.dataset.show;
  password.type = reveal ? 'text' : 'password';
  toggle.textContent = label;
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('aria-pressed', String(reveal));
});
