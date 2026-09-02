const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'skillhub_secret_key_2026';

app.use(cors());
app.use(express.json());

// Base de datos temporal en memoria
const db = {
    users: [
        {
            id: 1,
            email: 'support.hubskill@gmail.com',
            passwordHash: bcrypt.hashSync('SkillHub2026!AdminSec', 10),
            role: 'admin',
            name: 'Admin SkillHub'
        }
    ],
    services: [
        {
            id: 101,
            providerName: "Carlos Pérez",
            name: "Desarrollo Web Fullstack",
            category: "Desarrollo",
            price: 100,
            rating: 4.9,
            completedJobs: 28,
            level: "Top Provider"
        }
    ],
    bookings: []
};

const COMMISSION_RATE = 0.10; // 10% de comisión de plataforma

// Rutas de autenticación
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, role, name } = req.body;
        if (!email || !password || !role) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }
        
        const existingUser = db.users.find(u => u.email === email);
        if (existingUser) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const newUser = { id: Date.now(), email, passwordHash, role, name: name || 'Usuario' };
        db.users.push(newUser);

        const token = jwt.sign({ id: newUser.id, role: newUser.role, email: newUser.email }, JWT_SECRET, { expiresIn: '1d' });
        res.status(201).json({ message: 'Usuario registrado con éxito', token, user: { id: newUser.id, email, role, name: newUser.name } });
    } catch (err) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = db.users.find(u => u.email === email);
        if (!user) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const validPass = await bcrypt.compare(password, user.passwordHash);
        if (!validPass) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '1d' });
        res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
    } catch (err) {
        res.status(500).json({ error: 'Error al iniciar sesión' });
    }
});

// Rutas de servicios y reservas
app.get('/api/services', (req, res) => {
    res.json(db.services);
});

app.post('/api/bookings', (req, res) => {
    const { serviceId, clientId, date } = req.body;
    const service = db.services.find(s => s.id === serviceId);
    if (!service) return res.status(404).json({ error: 'Servicio no encontrado' });

    const totalPaid = service.price;
    const commission = totalPaid * COMMISSION_RATE;
    const providerEarnings = totalPaid - commission;

    const newBooking = {
        id: 'RES-' + Date.now(),
        serviceId,
        serviceName: service.name,
        clientId,
        date,
        totalPaid,
        commission,
        providerEarnings,
        status: 'pendiente',
        created_at: new Date()
    };

    db.bookings.push(newBooking);
    res.status(201).json({ message: 'Reserva realizada con éxito', booking: newBooking });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
});
