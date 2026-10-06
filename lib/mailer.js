import nodemailer from 'nodemailer';

// Crea el transporter a partir de variables de entorno.
// Si SMTP_HOST no está configurado, los emails no se envían (modo "pendiente de config").
function crearTransporter() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function enviarEmailReset({ to, username, resetUrl }) {
  const transporter = crearTransporter();
  if (!transporter) {
    // SMTP no configurado: loguear el link para que el admin lo copie manualmente.
    console.warn(`[RESET] Email no enviado (SMTP sin configurar). Link para ${username}: ${resetUrl}`);
    return { enviado: false };
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Restablecer contraseña — Fusion Bikes Herramientas',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0C0F16;color:#E4EAF4;padding:32px;border-radius:12px">
        <p style="color:#2DB8E8;font-weight:700;letter-spacing:.1em;font-size:.75rem;text-transform:uppercase;margin-bottom:8px">Fusion Bikes · Herramientas</p>
        <h2 style="font-size:1.4rem;font-weight:800;margin-bottom:12px">Restablecer contraseña</h2>
        <p style="color:#9BA8C0;font-size:.9rem;line-height:1.6">Recibimos una solicitud para restablecer la contraseña de <strong style="color:#E4EAF4">${username}</strong>. Hacé clic en el botón para continuar. El link es válido por 1 hora.</p>
        <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:12px 22px;background:#2DB8E8;color:#0C0F16;font-weight:700;border-radius:8px;text-decoration:none">Restablecer contraseña</a>
        <p style="color:#6B7A9B;font-size:.78rem;line-height:1.6">Si no pediste este cambio, ignorá este mensaje. El link expira en 1 hora.</p>
        <hr style="border:none;border-top:1px solid #24304A;margin:20px 0">
        <p style="color:#6B7A9B;font-size:.72rem">Si el botón no funciona, copiá este link:<br><span style="color:#2DB8E8;word-break:break-all">${resetUrl}</span></p>
      </div>
    `,
    text: `Restablecer contraseña — Fusion Bikes\n\nUsuario: ${username}\n\nLink (válido 1 hora):\n${resetUrl}\n\nSi no pediste este cambio, ignorá este mensaje.`,
  });
  return { enviado: true };
}

// Alerta de token ML sin poder renovarse (fallos sostenidos) o recuperado.
// `to` puede venir vacío/undefined (ALERTAS_EMAIL sin configurar): fallback silencioso,
// no debe romper el sync por no poder mandar mail.
export async function enviarAlertaTokenMl({ to, mensaje, recuperado = false }) {
  if (!to) {
    console.warn(`[ALERTA ML] ALERTAS_EMAIL no configurado. ${recuperado ? 'Recuperado' : 'Fallo sostenido'}: ${mensaje}`);
    return { enviado: false };
  }
  const transporter = crearTransporter();
  if (!transporter) {
    console.warn(`[ALERTA ML] Email no enviado (SMTP sin configurar). ${recuperado ? 'Recuperado' : 'Fallo sostenido'}: ${mensaje}`);
    return { enviado: false };
  }
  const asunto = recuperado
    ? 'Token ML recuperado — Fusion Bikes Herramientas'
    : 'ALERTA: Token ML sin renovar — Fusion Bikes Herramientas';
  const cuerpo = recuperado
    ? `El token de MercadoLibre se renovó correctamente luego del episodio de fallos.`
    : `El token de MercadoLibre lleva un tiempo sostenido sin poder renovarse.\n\nMotivo: ${mensaje}`;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: asunto,
      text: cuerpo,
      html: `<div style="font-family:sans-serif"><p>${cuerpo.replace(/\n/g, '<br>')}</p></div>`,
    });
    return { enviado: true };
  } catch (e) {
    // Nunca romper el flujo de sync por un fallo de envío de mail.
    console.error('[ALERTA ML] Error enviando mail de alerta:', e.message);
    return { enviado: false };
  }
}

export async function enviarAlertaIncidente({ to, incidente, recuperado = false }) {
  if (!to) return { enviado: false };
  const transporter = crearTransporter();
  if (!transporter) return { enviado: false };
  const integracion = incidente?.integracion || 'integración';
  const proceso = incidente?.proceso || 'proceso desconocido';
  const asunto = recuperado
    ? `RECUPERADO: conexión ${integracion} — Fusion Bikes`
    : `ALERTA: conexión ${integracion} — Fusion Bikes`;
  const cuerpo = recuperado
    ? `La conexión con ${integracion} se recuperó.\n\nProceso: ${proceso}\nIncidente: #${incidente?.id ?? 'n/d'}`
    : `Se detectó una caída o degradación de conexión.\n\nIntegración: ${integracion}\nProceso: ${proceso}\nSeveridad: ${incidente?.severidad || 'advertencia'}\nDetalle: ${incidente?.mensaje_humano || 'sin detalle'}\nIncidente: #${incidente?.id ?? 'n/d'}\nDetectado: ${incidente?.primera_deteccion_en || 'n/d'}`;
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: asunto, text: cuerpo,
      html: `<div style="font-family:sans-serif"><h2>${asunto}</h2><p>${cuerpo.replace(/\n/g, '<br>')}</p></div>` });
    return { enviado: true };
  } catch (e) {
    console.error('[ALERTA INCIDENTE] Error enviando mail:', e.message);
    return { enviado: false };
  }
}
