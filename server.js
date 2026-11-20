const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '7mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
const SECRET = process.env.JWT_SECRET;
const managers = ['DIRETOR_PRESIDENTE', 'SOCIO_PRESIDENTE', 'DIRETOR_COMERCIAL'];
const roles = [...managers, 'CAMINHONEIRO'];

async function init() {
  if (!process.env.DATABASE_URL || !SECRET) throw new Error('Configure DATABASE_URL e JWT_SECRET.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'CONTRATANTE',
      kind TEXT NOT NULL DEFAULT 'contractor', status TEXT NOT NULL DEFAULT 'approved',
      company TEXT, cnpj TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS carousel (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, image_data TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, contractor_id INTEGER REFERENCES users(id),
      company TEXT NOT NULL, cnpj TEXT, products TEXT NOT NULL, requested_date TEXT,
      requested_time TEXT, receiver_available BOOLEAN DEFAULT false, company_photo TEXT,
      status TEXT NOT NULL DEFAULT 'Solicitação recebida',
      driver_id INTEGER REFERENCES users(id), receiver_name TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tracking_events (
      id SERIAL PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      event TEXT NOT NULL, photo TEXT, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY, sender TEXT NOT NULL, company TEXT, driver TEXT,
      occurrence_date TEXT, description TEXT NOT NULL, attachment TEXT,
      status TEXT NOT NULL DEFAULT 'Recebida', created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (email && password) {
    const found = await pool.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
    if (!found.rowCount) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        `INSERT INTO users(name,email,password_hash,role,kind,status)
         VALUES($1,$2,$3,'DIRETOR_PRESIDENTE','employee','approved')`,
        ['Diretor-Presidente', email.toLowerCase(), hash]
      );
      console.log('Usuário inicial Diretor-Presidente criado.');
    }
  }
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    if (!token) throw new Error('Token ausente');
    req.user = jwt.verify(token, SECRET);
    next();
  } catch { res.status(401).json({ error: 'Faça login novamente.' }); }
}
function allow(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    next();
  };
}
function manager(req, res, next) {
  if (!managers.includes(req.user.role)) return res.status(403).json({ error: 'Acesso restrito à direção.' });
  next();
}
function safeUser(u) {
  return { id:u.id, name:u.name, email:u.email, role:u.role, kind:u.kind, status:u.status, company:u.company, cnpj:u.cnpj };
}
const statuses = ['Base', 'Em deslocamento', 'Em deslocamento para o local', 'Pedido concluído'];

app.get('/api/health', (req,res) => res.json({ ok:true, service:'Irmandade Transportadora' }));

app.post('/api/register', async (req,res) => {
  try {
    const { name, email, password, kind, company, cnpj } = req.body;
    if (!name || !email || !password || password.length < 8) return res.status(400).json({error:'Preencha nome, e-mail e senha com pelo menos 8 caracteres.'});
    const employee = kind === 'employee';
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users(name,email,password_hash,role,kind,status,company,cnpj)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name.trim(), email.toLowerCase().trim(), hash, employee ? 'CAMINHONEIRO' : 'CONTRATANTE',
       employee ? 'employee' : 'contractor', employee ? 'pending' : 'approved', company || null, cnpj || null]
    );
    res.status(201).json({message: employee ? 'Cadastro enviado. Aguarde a aprovação da direção.' : 'Conta criada. Você já pode entrar.', pending:employee});
  } catch(e) { res.status(400).json({error: e.code === '23505' ? 'Este e-mail já está cadastrado.' : 'Não foi possível criar a conta.'}); }
});

app.post('/api/login', async (req,res) => {
  const { email, password } = req.body;
  const r = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email || '']);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) return res.status(401).json({error:'E-mail ou senha incorretos.'});
  if (u.status !== 'approved') return res.status(403).json({error:'Seu cadastro ainda aguarda aprovação da administração.'});
  const token = jwt.sign({id:u.id, name:u.name, role:u.role, kind:u.kind}, SECRET, {expiresIn:'12h'});
  res.json({token, user:safeUser(u)});
});
app.get('/api/me', auth, async (req,res) => {
  const r = await pool.query('SELECT * FROM users WHERE id=$1',[req.user.id]);
  if (!r.rowCount) return res.status(404).json({error:'Usuário não encontrado.'});
  res.json({user:safeUser(r.rows[0])});
});

app.get('/api/carousel', async (req,res) => {
  const r = await pool.query('SELECT id,title,image_data FROM carousel ORDER BY id DESC');
  res.json(r.rows);
});
app.post('/api/carousel', auth, manager, async (req,res) => {
  const {title,imageData} = req.body;
  if (!title || !imageData || !/^data:image\/(png|jpeg|webp);base64,/.test(imageData)) return res.status(400).json({error:'Envie título e imagem PNG, JPG ou WEBP.'});
  if (imageData.length > 5_500_000) return res.status(413).json({error:'Imagem muito grande. Limite aproximado de 4 MB.'});
  const r = await pool.query('INSERT INTO carousel(title,image_data) VALUES($1,$2) RETURNING id,title,image_data',[title,imageData]);
  res.status(201).json(r.rows[0]);
});
app.delete('/api/carousel/:id', auth, manager, async (req,res) => {
  await pool.query('DELETE FROM carousel WHERE id=$1',[req.params.id]); res.json({ok:true});
});

app.get('/api/orders', auth, async (req,res) => {
  let r;
  if (req.user.kind === 'contractor') {
    r = await pool.query(`SELECT o.*, u.name driver_name FROM orders o LEFT JOIN users u ON u.id=o.driver_id WHERE contractor_id=$1 ORDER BY o.id DESC`,[req.user.id]);
  } else if (req.user.role === 'CAMINHONEIRO') {
    r = await pool.query(`SELECT o.*, u.name driver_name FROM orders o LEFT JOIN users u ON u.id=o.driver_id WHERE o.driver_id=$1 OR o.driver_id IS NULL ORDER BY o.id DESC`,[req.user.id]);
  } else {
    r = await pool.query(`SELECT o.*, u.name driver_name FROM orders o LEFT JOIN users u ON u.id=o.driver_id ORDER BY o.id DESC`);
  }
  res.json(r.rows);
});
app.post('/api/orders', auth, async (req,res) => {
  if (req.user.kind !== 'contractor') return res.status(403).json({error:'Somente contratantes podem solicitar.'});
  const {company,cnpj,products,requestedDate,requestedTime,receiverAvailable,companyPhoto} = req.body;
  if (!company || !products || !requestedDate || !requestedTime) return res.status(400).json({error:'Informe empresa, produtos, data e horário.'});
  const r = await pool.query(
    `INSERT INTO orders(contractor_id,company,cnpj,products,requested_date,requested_time,receiver_available,company_photo)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.id,company,cnpj || null,products,requestedDate,requestedTime,!!receiverAvailable,companyPhoto || null]
  );
  await pool.query('INSERT INTO tracking_events(order_id,status) VALUES($1,$2)',[r.rows[0].id,'Solicitação recebida']);
  res.status(201).json(r.rows[0]);
});
app.post('/api/orders/:id/claim', auth, allow('CAMINHONEIRO'), async (req,res) => {
  const r = await pool.query(`UPDATE orders SET driver_id=$1,status='Base' WHERE id=$2 AND driver_id IS NULL RETURNING *`,[req.user.id,req.params.id]);
  if (!r.rowCount) return res.status(409).json({error:'Este agendamento já foi assumido ou não existe.'});
  await pool.query('INSERT INTO tracking_events(order_id,status,note) VALUES($1,$2,$3)',[req.params.id,'Base',`Assumido por ${req.user.name}`]);
  res.json({ok:true});
});
app.post('/api/orders/:id/status', auth, async (req,res) => {
  const {status,note,receiverName} = req.body;
  if (!statuses.includes(status)) return res.status(400).json({error:'Status inválido.'});
  const order = await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!order.rowCount) return res.status(404).json({error:'Pedido não encontrado.'});
  const o = order.rows[0];
  const isManager = managers.includes(req.user.role);
  if (!isManager && (req.user.role !== 'CAMINHONEIRO' || o.driver_id !== req.user.id)) return res.status(403).json({error:'Somente o caminhoneiro responsável pode atualizar esta entrega.'});
  if (status === 'Pedido concluído' && !receiverName) return res.status(400).json({error:'Informe o nome de quem recebeu.'});
  await pool.query(`UPDATE orders SET status=$1, receiver_name=CASE WHEN $1='Pedido concluído' THEN $2 ELSE receiver_name END, completed_at=CASE WHEN $1='Pedido concluído' THEN NOW() ELSE completed_at END WHERE id=$3`,[status,receiverName || null,req.params.id]);
  await pool.query('INSERT INTO tracking_events(order_id,status,note) VALUES($1,$2,$3)',[req.params.id,status,note || (receiverName ? `Recebido por ${receiverName}` : null)]);
  res.json({ok:true});
});
app.get('/api/orders/:id/events', auth, async (req,res) => {
  const o = await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if (!o.rowCount) return res.status(404).json({error:'Pedido não encontrado.'});
  const order = o.rows[0];
  const permitted = managers.includes(req.user.role) || order.contractor_id === req.user.id || order.driver_id === req.user.id;
  if (!permitted) return res.status(403).json({error:'Sem permissão.'});
  const r = await pool.query('SELECT * FROM tracking_events WHERE order_id=$1 ORDER BY id',[req.params.id]);
  res.json(r.rows);
});

app.post('/api/time', auth, allow('CAMINHONEIRO'), async (req,res) => {
  const {event,photo,note} = req.body;
  if (!['Início','Pausa','Fim'].includes(event)) return res.status(400).json({error:'Evento inválido.'});
  if ((event === 'Início' || event === 'Fim') && !photo) return res.status(400).json({error:'A foto é obrigatória para início e fim do turno.'});
  if (photo && photo.length > 5_500_000) return res.status(413).json({error:'Foto muito grande.'});
  const r = await pool.query('INSERT INTO time_entries(user_id,event,photo,note) VALUES($1,$2,$3,$4) RETURNING id,event,note,created_at',[req.user.id,event,photo || null,note || null]);
  res.status(201).json(r.rows[0]);
});
app.get('/api/time', auth, async (req,res) => {
  const isManager = managers.includes(req.user.role);
  const r = isManager
    ? await pool.query(`SELECT t.id,t.event,t.note,t.created_at,u.name FROM time_entries t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 200`)
    : await pool.query(`SELECT id,event,note,created_at FROM time_entries WHERE user_id=$1 ORDER BY id DESC LIMIT 100`,[req.user.id]);
  res.json(r.rows);
});

app.post('/api/complaints', async (req,res) => {
  const {sender,company,driver,occurrenceDate,description,attachment} = req.body;
  if (!sender || !description) return res.status(400).json({error:'Informe seu nome e descreva a ocorrência.'});
  if (attachment && attachment.length > 5_500_000) return res.status(413).json({error:'Anexo muito grande.'});
  await pool.query(`INSERT INTO complaints(sender,company,driver,occurrence_date,description,attachment) VALUES($1,$2,$3,$4,$5,$6)`,
    [sender,company || null,driver || null,occurrenceDate || null,description,attachment || null]);
  res.status(201).json({message:'Relato enviado à ouvidoria. Obrigado por contribuir com a segurança.'});
});
app.get('/api/complaints', auth, manager, async (req,res) => {
  const r = await pool.query('SELECT id,sender,company,driver,occurrence_date,description,status,created_at FROM complaints ORDER BY id DESC');
  res.json(r.rows);
});
app.patch('/api/complaints/:id', auth, manager, async (req,res) => {
  const {status} = req.body;
  await pool.query('UPDATE complaints SET status=$1 WHERE id=$2',[status,req.params.id]); res.json({ok:true});
});

app.get('/api/users', auth, manager, async (req,res) => {
  const r = await pool.query('SELECT id,name,email,role,kind,status,company,cnpj,created_at FROM users ORDER BY id DESC');
  res.json(r.rows);
});
app.patch('/api/users/:id', auth, manager, async (req,res) => {
  const {status,role} = req.body;
  if (status && !['approved','pending','rejected'].includes(status)) return res.status(400).json({error:'Status inválido.'});
  if (role && !roles.includes(role) && role !== 'CONTRATANTE') return res.status(400).json({error:'Cargo inválido.'});
  const current = await pool.query('SELECT * FROM users WHERE id=$1',[req.params.id]);
  if (!current.rowCount) return res.status(404).json({error:'Usuário não encontrado.'});
  const u = current.rows[0];
  if (u.id === req.user.id && status && status !== 'approved') return res.status(400).json({error:'Você não pode bloquear sua própria conta.'});
  await pool.query('UPDATE users SET status=COALESCE($1,status), role=COALESCE($2,role) WHERE id=$3',[status || null,role || null,req.params.id]);
  res.json({ok:true});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => console.log(`Irmandade Transportadora rodando na porta ${port}`)))
  .catch(err => { console.error('Falha ao iniciar:',err); process.exit(1); });
