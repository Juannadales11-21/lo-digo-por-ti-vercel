// Servidor Express para desarrollo local; en Vercel se usa la funcion serverless /api/generate-message.
const path = require('path');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

// Prefer server.env for local secrets; fallback to .env if missing.
const dotenvResult = dotenv.config({ path: path.join(__dirname, 'server.env') });
if (dotenvResult.error) {
  dotenv.config();
}

console.log('CLAVE CARGADA?', process.env.OPENAI_API_KEY ? 'SI' : 'NO');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Limita spam en /api/generate-message con 5 peticiones por IP y minuto.
const generateMessageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res
      .status(429)
      .json({ error: 'Has hecho demasiadas peticiones, espera un poco antes de volver a intentarlo.' });
  }
});

// Control diario en memoria por IP (reinicia cada dia).
const dailyUsage = {
  date: new Date().toISOString().slice(0, 10),
  counts: {}
};

function resetDailyUsageIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyUsage.date !== today) {
    dailyUsage.date = today;
    dailyUsage.counts = {};
  }
}

function enforceDailyLimit(req, res, next) {
  resetDailyUsageIfNeeded();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const current = dailyUsage.counts[ip] || 0;

  if (current >= 100) {
    return res.status(429).json({ error: 'Has alcanzado el limite diario de uso gratuito. Vuelve manana.' });
  }

  dailyUsage.counts[ip] = current + 1;
  next();
}

// Plantillas fijas cuando la API no tiene saldo.
const quotaFallbackMessages = [
  'Ahora mismo la IA no puede generar un mensaje porque se ha alcanzado el limite de uso, pero puedes decir algo como:\n\nHola, queria comentarte [tu peticion] de forma sincera y respetuosa. Para mi es importante que podamos hablarlo con calma y ver que opciones tenemos.',
  'Parece que el motor de IA esta en pausa por limite de cuota. Mientras tanto, prueba con algo asi:\n\nBuenas, te escribo porque ha pasado [situacion]. Me gustaria encontrar una solucion que sea razonable para las dos partes.',
  'La IA no esta disponible en este momento (limite de uso), pero puedes usar esta plantilla:\n\nHola [nombre], gracias por tu tiempo. Queria explicarte brevemente lo que ha ocurrido: [resumen]. Me gustaria saber si podemos revisarlo juntos y ver la mejor forma de seguir.'
];

const channelGuidance = {
  whatsapp:
    'Canal: WhatsApp. Mensajes breves y coloquiales, estilo chat. Se permiten emojis ligeros solo si el tono no es formal.',
  email_formal:
    'Canal: email formal. Incluye saludo breve, cuerpo conciso y cierre cordial. Nada de emojis ni coletillas de IA.',
  linkedin:
    'Canal: LinkedIn. Profesional pero cercano, 2-4 frases claras orientadas a networking o trabajo. Sin emojis excesivos.',
  nota_voz:
    'Canal: nota de voz. Estilo oral y fluido, frases algo mas largas con conectores naturales, sonido conversacional.'
};

const intensityLabels = {
  1: 'muy suave',
  2: 'neutro',
  3: 'directo',
  4: 'muy directo'
};

const languageNames = {
  es: 'espanol',
  en: 'ingles',
  fr: 'frances',
  de: 'aleman',
  it: 'italiano',
  pt: 'portugues'
};

const firmnessGuidance = {
  soft:
    'El mensaje debe ser muy cuidadoso y suave, priorizando empatia, comprension y delicadeza al expresar la idea.',
  normal:
    'El mensaje debe ser equilibrado: claro y respetuoso, sin sonar ni demasiado duro ni demasiado blando.',
  direct: 'El mensaje debe ser claro y directo, expresando lo que necesitas de forma firme pero educada.',
  very_direct:
    'El mensaje debe ser muy claro y directo, marcando limites o necesidades de manera firme y sin rodeos, pero sin faltar al respeto.'
};

app.post('/api/generate-message', generateMessageLimiter, enforceDailyLimit, async (req, res) => {
  const { situation, tone, channel, intensity, language, humanize, firmness, wordTarget } = req.body || {};

  const trimmedSituation = (situation || '').trim();
  const toneLabel = (tone || 'formal').toLowerCase();
  const channelKey = (channel || 'whatsapp').toLowerCase();
  const rawIntensity = Number(intensity);
  const intensityLevel =
    Number.isFinite(rawIntensity) && rawIntensity >= 1 && rawIntensity <= 4 ? Math.round(rawIntensity) : 2;
  const languageCode = (language || 'es').toLowerCase();
  const languageName = languageNames[languageCode] || languageNames.es;
  const humanizeEnabled = humanize === true || humanize === 'true';
  const firmnessKey = (firmness || '').toLowerCase();
  const normalizedFirmness = ['soft', 'normal', 'direct', 'very_direct'].includes(firmnessKey)
    ? firmnessKey
    : 'normal';
  const rawWordTarget = Number(wordTarget);
  const safeWordTarget =
    Number.isFinite(rawWordTarget) && rawWordTarget >= 10 && rawWordTarget <= 300
      ? Math.round(rawWordTarget)
      : 100;

  if (!trimmedSituation) {
    return res.status(400).json({ error: 'La situacion es obligatoria.' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Falta la clave de API. Configura OPENAI_API_KEY.' });
  }

  const channelInstruction = channelGuidance[channelKey] || channelGuidance.whatsapp;
  const firmnessInstruction = firmnessGuidance[normalizedFirmness];
  const humanizeInstruction = humanizeEnabled
    ? 'Si "humanize" esta activado, usa un estilo natural, cotidiano y cercano, como una persona real.'
    : '';
  const lengthInstruction = `Cada mensaje debe tener aproximadamente ${safeWordTarget} palabras. Acercate lo maximo posible a ese numero sin pasarte demasiado.`;

  const prompt = `
Eres una persona que escribe mensajes cortos listos para el canal indicado.
Idioma: ${languageName}. Responde siempre en ${languageName}, sin traducciones adicionales.
Canal: ${channelInstruction}
Genera 3 versiones distintas para la siguiente situacion: "${trimmedSituation}".
El tono debe ser: ${toneLabel}.
${firmnessInstruction}
${humanizeInstruction}
${lengthInstruction}
Devuelve la respuesta solo como JSON valido con esta forma:
{"messages": ["mensaje 1", "mensaje 2", "mensaje 3"]}`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        {
          role: 'system',
          content:
            'Eres una persona que redacta mensajes breves y naturales para distintos canales. Responde siempre en el idioma indicado por el usuario, sin traducciones adicionales, y devuelve solo JSON con la forma {"messages": ["mensaje 1", "mensaje 2", "mensaje 3"]}.'
        },
        { role: 'user', content: prompt }
      ]
    });

    const rawContent = completion.choices?.[0]?.message?.content?.trim() || '';
    let parsed;

    try {
      parsed = JSON.parse(rawContent);
    } catch (error) {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      }
    }

    const messages = Array.isArray(parsed?.messages) ? parsed.messages.filter(Boolean).slice(0, 3) : [];

    if (!messages.length) {
      return res.status(500).json({ error: 'No se pudieron generar mensajes.' });
    }

    res.json({ messages });
  } catch (error) {
    const quotaExceeded =
      error?.error?.code === 'insufficient_quota' || error?.status === 429 || error?.response?.status === 429;
    if (quotaExceeded) {
      return res.status(200).json({ messages: quotaFallbackMessages });
    }

    console.error('Error al generar mensajes', error);
    res.status(500).json({ error: 'No se pudo generar el mensaje. Intenta nuevamente en unos minutos.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
