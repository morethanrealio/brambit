// The logged-in administrator (ADMIN_EMAIL), or null. Screens and routes that
// only the administrator sees answer anyone else as if they did not exist.
export async function adminUser(ctx) {
  const admin = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!admin) return null;
  const user = await ctx.currentUser?.();
  return user && String(user.email || '').toLowerCase() === admin ? user : null;
}
