// Reuse the existing billingFlash region; never interpret message as HTML.
export function showPlanSwitch(node, value) {
    if (!node || !value || typeof value !== 'object')
        return null;
    const data = value;
    if (typeof data.switched !== 'boolean')
        return null;
    const message = typeof data.message === 'string' && data.message.trim()
        ? data.message : 'Não foi possível confirmar o resultado. Confira em Gerenciar assinatura antes de tentar novamente.';
    node.textContent = message;
    node.style.color = 'var(--txt, #2b2723)';
    node.style.lineHeight = '1.5';
    node.setAttribute('role', data.switched ? 'status' : 'alert');
    node.setAttribute('aria-live', data.switched ? 'polite' : 'assertive');
    node.tabIndex = -1;
    node.classList.remove('hidden');
    node.focus({ preventScroll: true });
    return message;
}
export function clearPlanSwitch(node) {
    if (!node)
        return;
    node.textContent = '';
    node.classList.add('hidden');
    node.removeAttribute('role');
    node.removeAttribute('aria-live');
}
