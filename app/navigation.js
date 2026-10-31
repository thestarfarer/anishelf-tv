(function () {
  'use strict';
  const A = window.AniShelf;
  let modalReturn = null;
  function visible(element) {
    return !element.disabled && !element.closest('[hidden]') && !!(element.offsetWidth || element.offsetHeight);
  }
  function scope() {
    if (!document.getElementById('modal').hidden) return document.getElementById('modal-body');
    if (!document.getElementById('player').hidden) return document.getElementById('player');
    return document.getElementById('shell');
  }
  function focusables(root) {
    return Array.from((root || scope()).querySelectorAll('button, input, select, textarea, [tabindex="0"]')).filter(visible);
  }
  function focus(element) {
    if (!element || !visible(element)) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function move(direction) {
    const candidates = focusables();
    const current = document.activeElement;
    if (!candidates.includes(current)) { focus(candidates[0]); return; }
    const from = current.getBoundingClientRect();
    const x = from.left + from.width / 2, y = from.top + from.height / 2;
    let best = null, score = Infinity;
    for (const element of candidates) {
      if (element === current) continue;
      const r = element.getBoundingClientRect();
      const dx = r.left + r.width / 2 - x, dy = r.top + r.height / 2 - y;
      const horizontal = direction === 'left' || direction === 'right';
      const main = horizontal ? dx * (direction === 'left' ? -1 : 1) : dy * (direction === 'up' ? -1 : 1);
      if (main <= 3) continue;
      const cross = Math.abs(horizontal ? dy : dx);
      const overlap = horizontal ? r.bottom > from.top && r.top < from.bottom : r.right > from.left && r.left < from.right;
      const cost = main + cross * (overlap ? .7 : 3.2) + (overlap ? 0 : 100);
      if (cost < score) { score = cost; best = element; }
    }
    // Leaving the page sideways returns to the page's own menu entry, not whichever is level with it.
    if (direction === 'left' && best?.closest('.sidebar') && !current.closest('.sidebar')) {
      best = document.querySelector('.sidebar .nav-item.active') || best;
    }
    focus(best);
  }
  document.addEventListener('keydown', event => {
    const code = event.keyCode;
    const target = event.target;
    const modal = !document.getElementById('modal').hidden;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if (event.key === 'Tab') {
      if (!modal) return;
      const elements = focusables(), i = elements.indexOf(target);
      event.preventDefault(); focus(elements[(i + (event.shiftKey ? -1 : 1) + elements.length) % elements.length]); return;
    }
    if (code === 461 || event.key === 'Escape' || (!editing && event.key === 'Backspace')) {
      event.preventDefault();
      if (modal) A.closeModal(); else if (A.player?.active()) A.player.close(); else A.back?.();
      return;
    }
    if (!modal && A.player?.active() && A.player.handleKey(event)) return;
    if (editing) {
      if (target.tagName === 'SELECT') return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); move(event.key === 'ArrowDown' ? 'down' : 'up');
      }
      return;
    }
    const directions = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (directions[event.key]) { event.preventDefault(); move(directions[event.key]); }
  });
  // The Magic Remote pointer moves focus to what it hovers, except out of a text field: the TV
  // closes its on-screen keyboard as soon as a field loses focus.
  const typing = element => !!element && (element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(element.type)));
  document.addEventListener('pointerover', event => {
    const target = event.target.closest('button');
    if (target && visible(target) && !typing(document.activeElement)) target.focus({ preventScroll: true });
  });
  A.nav = { focus, first: root => focus(focusables(root)[0]), move };
  A.openModal = (title, build) => {
    modalReturn = document.activeElement;
    const body = document.getElementById('modal-body'); body.replaceChildren();
    document.getElementById('modal').classList.remove('dropdown'); body.removeAttribute('style');
    const h = document.createElement('h2'); h.textContent = title; body.append(h);
    build(body);
    document.getElementById('modal').hidden = false;
    A.nav.first(body);
  };
  // A styled replacement for <select>: TV browsers draw native option lists as plain square boxes.
  A.openDropdown = (anchor, options, onPick) => {
    modalReturn = anchor;
    const modal = document.getElementById('modal'), body = document.getElementById('modal-body');
    body.replaceChildren(); modal.classList.add('dropdown');
    const list = document.createElement('div'); list.className = 'modal-list dropdown-list'; list.setAttribute('role', 'listbox');
    for (const option of options) {
      const button = document.createElement('button'); button.textContent = option.label; button.setAttribute('role', 'option');
      if (option.selected) { button.className = 'selected'; button.setAttribute('aria-selected', 'true'); }
      button.onclick = () => { A.closeModal(); onPick(option.value); };
      list.append(button);
    }
    body.append(list);
    modal.hidden = false;
    const r = anchor.getBoundingClientRect(), width = Math.max(r.width, 300);
    body.style.width = width + 'px';
    body.style.left = Math.max(24, Math.min(window.innerWidth - width - 24, r.right - width)) + 'px';
    const height = body.offsetHeight, fitsBelow = r.bottom + 10 + height <= window.innerHeight - 24;
    body.style.top = Math.max(24, fitsBelow ? r.bottom + 10 : r.top - 10 - height) + 'px';
    focus(list.querySelector('.selected') || list.querySelector('button'));
  };
  A.closeModal = () => {
    const modal = document.getElementById('modal');
    modal.classList.remove('dropdown'); document.getElementById('modal-body').removeAttribute('style');
    document.getElementById('modal').hidden = true;
    if (modalReturn?.isConnected) focus(modalReturn);
    else A.nav.first();
    modalReturn = null;
  };
})();
