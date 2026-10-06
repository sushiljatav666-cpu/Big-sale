require("dotenv").config();
const express=require("express");
const path=require("path");
const bcrypt=require("bcryptjs");
const cookieParser=require("cookie-parser");
const jwt=require("jsonwebtoken");
const Database=require("better-sqlite3");

const app=express();
const PORT=Number(process.env.PORT||3000);
const JWT_SECRET=process.env.JWT_SECRET;
const ADMIN_EMAIL=process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH=process.env.ADMIN_PASSWORD_HASH;
const isProduction=process.env.NODE_ENV==="production";

if(isProduction && (!JWT_SECRET || JWT_SECRET.length<32)) throw new Error("JWT_SECRET must be set and at least 32 characters in production");
if(!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD_HASH are required");

app.disable("x-powered-by");
app.set("trust proxy", 1);

// Basic same-origin/security headers without adding another runtime dependency.
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  if(isProduction) res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
  next();
});

// Same-origin app: do not enable wide-open CORS in production.
app.use(cookieParser());
app.use(express.json({limit:"100kb"}));
app.use(express.urlencoded({extended:false,limit:"50kb"}));
app.use(express.static(path.join(__dirname,"public"),{maxAge:isProduction?"1d":0}));

const db=new Database(process.env.DB_PATH||path.join(__dirname,"shop.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 description TEXT DEFAULT '',
 price REAL NOT NULL CHECK(price>=0),
 discount REAL DEFAULT 0 CHECK(discount>=0 AND discount<=100),
 image TEXT DEFAULT '',
 stock INTEGER DEFAULT 0 CHECK(stock>=0),
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_name TEXT NOT NULL,
 email TEXT NOT NULL,
 phone TEXT DEFAULT '',
 address TEXT NOT NULL,
 items TEXT NOT NULL,
 subtotal REAL NOT NULL,
 discount REAL DEFAULT 0,
 total REAL NOT NULL,
 payment_status TEXT DEFAULT 'pending',
 order_status TEXT DEFAULT 'new',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

if(db.prepare("SELECT COUNT(*) c FROM products").get().c===0){
 db.prepare("INSERT INTO products(name,description,price,discount,image,stock) VALUES (?,?,?,?,?,?)")
 .run("Sample T-Shirt","Replace this sample product from Admin.",799,10,"https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=80",20);
}

const attempts=new Map();
function rateLimit(key,max,windowMs){
 const now=Date.now(), a=attempts.get(key)||[];
 const fresh=a.filter(t=>now-t<windowMs);
 if(fresh.length>=max){attempts.set(key,fresh);return false;}
 fresh.push(now);attempts.set(key,fresh);return true;
}
setInterval(()=>{const now=Date.now();for(const [k,a] of attempts) {const f=a.filter(t=>now-t<15*60*1000);if(f.length) attempts.set(k,f); else attempts.delete(k);}},15*60*1000).unref();

function auth(req,res,next){
 try{
  const token=req.cookies?.admin_token || (req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  if(!token) throw new Error();
  req.user=jwt.verify(token,JWT_SECRET);
  if(req.user.role!=="admin") throw new Error();
  next();
 }catch{res.status(401).json({error:"Unauthorized"});}
}
function cleanProduct(p){
 const price=Number(p.price), discount=Number(p.discount??0), stock=Number(p.stock??0);
 if(!p.name || String(p.name).trim().length>120 || !Number.isFinite(price)||price<0 || !Number.isFinite(discount)||discount<0||discount>100 || !Number.isInteger(stock)||stock<0) throw new Error("Invalid product data");
 return {name:String(p.name).trim(),description:String(p.description||"").trim().slice(0,2000),price,discount,stock,image:String(p.image||"").trim().slice(0,1000)};
}
function cleanCustomer(c){
 const name=String(c?.name||"").trim(), email=String(c?.email||"").trim().toLowerCase(), phone=String(c?.phone||"").trim(), address=String(c?.address||"").trim();
 if(name.length<2||name.length>100) throw new Error("Invalid name");
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>200) throw new Error("Invalid email");
 if(phone.length>30||address.length<5||address.length>1000) throw new Error("Invalid checkout details");
 return {name,email,phone,address};
}

app.get("/api/health",(req,res)=>res.json({ok:true}));
app.get("/api/products",(req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all()));

app.post("/api/orders",(req,res)=>{
 try{
  const customer=cleanCustomer(req.body.customer);
  const items=Array.isArray(req.body.items)?req.body.items:[];
  if(!items.length||items.length>50) throw new Error("Invalid cart");
  const normalized=new Map();
  for(const x of items){const id=Number(x.id),qty=Number(x.qty);if(!Number.isInteger(id)||!Number.isInteger(qty)||qty<1||qty>50) throw new Error("Invalid cart item");normalized.set(id,(normalized.get(id)||0)+qty);}

  const tx=db.transaction(()=>{
   let subtotal=0,total=0;const finalItems=[];
   for(const [id,qty] of normalized){
    const p=db.prepare("SELECT * FROM products WHERE id=?").get(id);
    if(!p) throw new Error("Product unavailable");
    const unit=Number((p.price*(1-p.discount/100)).toFixed(2));
    const line=Number((unit*qty).toFixed(2));
    const updated=db.prepare("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?").run(qty,id,qty);
    if(updated.changes!==1) throw new Error(`Not enough stock: ${p.name}`);
    subtotal+=p.price*qty; total+=line;
    finalItems.push({id:p.id,name:p.name,qty,unit});
   }
   subtotal=Number(subtotal.toFixed(2));total=Number(total.toFixed(2));
   const discount=Number((subtotal-total).toFixed(2));
   const info=db.prepare(`INSERT INTO orders(customer_name,email,phone,address,items,subtotal,discount,total) VALUES(?,?,?,?,?,?,?,?)`).run(customer.name,customer.email,customer.phone,customer.address,JSON.stringify(finalItems),subtotal,discount,total);
   return {orderId:info.lastInsertRowid,total};
  });
  const result=tx();
  res.status(201).json({...result,paymentStatus:"pending"});
 }catch(e){res.status(400).json({error:e.message||"Order failed"});}
});

app.post("/api/admin/login",async(req,res)=>{
 const ip=req.ip||"unknown";
 if(!rateLimit(`login:${ip}`,8,15*60*1000)) return res.status(429).json({error:"Too many login attempts. Try again later."});
 try{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(email!==ADMIN_EMAIL.toLowerCase() || !(await bcrypt.compare(password,ADMIN_PASSWORD_HASH))) return res.status(401).json({error:"Invalid login"});
  const token=jwt.sign({email:ADMIN_EMAIL,role:"admin"},JWT_SECRET,{expiresIn:"8h"});
  res.cookie("admin_token",token,{httpOnly:true,secure:isProduction,sameSite:"strict",maxAge:8*60*60*1000,path:"/"});
  res.json({ok:true});
 }catch{res.status(401).json({error:"Invalid login"});}
});
app.post("/api/admin/logout",auth,(req,res)=>{res.clearCookie("admin_token",{httpOnly:true,secure:isProduction,sameSite:"strict",path:"/"});res.json({ok:true});});
app.get("/api/admin/orders",auth,(req,res)=>res.json(db.prepare("SELECT * FROM orders ORDER BY id DESC").all()));
app.post("/api/admin/products",auth,(req,res)=>{try{const p=cleanProduct(req.body);const r=db.prepare("INSERT INTO products(name,description,price,discount,image,stock) VALUES (?,?,?,?,?,?)").run(p.name,p.description,p.price,p.discount,p.image,p.stock);res.status(201).json({id:r.lastInsertRowid});}catch(e){res.status(400).json({error:e.message});}});
app.put("/api/admin/products/:id",auth,(req,res)=>{try{const p=cleanProduct(req.body);const r=db.prepare("UPDATE products SET name=?,description=?,price=?,discount=?,image=?,stock=? WHERE id=?").run(p.name,p.description,p.price,p.discount,p.image,p.stock,Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Product not found"});res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.delete("/api/admin/products/:id",auth,(req,res)=>{const r=db.prepare("DELETE FROM products WHERE id=?").run(Number(req.params.id));if(!r.changes)return res.status(404).json({error:"Product not found"});res.json({ok:true});});

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:"Internal server error"});});
app.use((req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Shop running on port ${PORT}`));
