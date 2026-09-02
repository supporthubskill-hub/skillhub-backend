const express = require('express');
const cors = require('cors');

const app = express();

// --- CONFIGURACIÓN DE CORS ---
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
            callback(null, true);
        } else {
            callback(new Error('Bloqueado por la política de CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// --- FILTRO DE LENGUAJE OFENSIVO (Multilingüe) ---
const palabrasProhibidas = ['spam', 'scam', 'badword1', 'badword2'];

function filtrarTexto(texto) {
    if (!texto || typeof texto !== 'string') return texto;
    let textoLimpio = texto;
    palabrasProhibidas.forEach(palabra => {
        const regex = new RegExp(palabra, 'gi');
        textoLimpio = textoLimpio.replace(regex, '****');
    });
    return textoLimpio;
}

// Base de datos simulada en memoria
let habilidades = [
    { id: 1, title: 'Desarrollo Web Fullstack', category: 'Tecnología', price: 150, provider: 'admin@skillhub.com' }
];

let ordenes = [];

// --- RUTAS DE LA API ---

// Health Check (Vital para Render)
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'SkillHub Backend Operativo 🚀' });
});

// Registro de Usuarios
app.post('/api/auth/register', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Correo y contraseña obligatorios.' });
    }
    res.status(201).json({ success: true, message: 'Usuario registrado con éxito.', user: { email } });
});

// Gestión de Habilidades / Servicios
app.get('/api/skills', (req, res) => {
    res.status(200).json({ success: true, data: habilidades });
});

app.post('/api/skills', (req, res) => {
    const { title, category, price, provider } = req.body;
    if (!title || !price) {
        return res.status(400).json({ success: false, message: 'Título y precio requeridos.' });
    }
    
    const nuevaHabilidad = {
        id: habilidades.length + 1,
        title: filtrarTexto(title),
        category,
        price,
        provider
    };

    habilidades.push(nuevaHabilidad);
    res.status(201).json({ success: true, message: 'Habilidad publicada con éxito', data: nuevaHabilidad });
});

// Órdenes y Comisiones Personalizadas
app.post('/api/orders', (req, res) => {
    const { skillId, clientEmail, customCommission } = req.body;
    const nuevaOrden = {
        id: ordenes.length + 1,
        skillId,
        clientEmail,
        customCommission: filtrarTexto(customCommission) || 'Estándar',
        status: 'Pendiente',
        createdAt: new Date()
    };
    ordenes.push(nuevaOrden);
    res.status(201).json({ success: true, message: 'Orden generada con éxito', data: nuevaOrden });
});

// Soporte Oficial (support.hubskill@gmail.com)
app.post('/api/support', (req, res) => {
    const { userEmail, message } = req.body;
    if (!message) {
        return res.status(400).json({ success: false, message: 'El mensaje no puede estar vacío.' });
    }
    
    const mensajeLimpio = filtrarTexto(message);
    console.log(`[SOPORTE SkillHub -> support.hubskill@gmail.com] De: ${userEmail} | Mensaje: ${mensajeLimpio}`);
    
    res.status(200).json({ 
        success: true, 
        message: 'Mensaje enviado a soporte (support.hubskill@gmail.com) exitosamente.' 
    });
});

// --- PUERTO DINÁMICO ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});

// --- MANEJO GLOBAL DE ERRORES ---
app.use((err, req, res, next) => {
    console.error('Error crítico detectado:', err.stack);
    res.status(500).json({
        success: false,
        message: 'Ocurrió un error interno en el servidor de SkillHub.'
    });
});