# Sushil Shop — deployment-ready starter

A Node.js/Express storefront with product management, cart/checkout, orders, and a private admin area.

## What is included
- Mobile-friendly product storefront
- Server-calculated prices and discounts; checkout never trusts browser prices
- Stock validation and transactional stock decrement
- SQLite database in WAL mode
- Admin login with bcrypt password hash, expiring JWT, HTTP-only cookie, and login throttling
- Security headers, request-size limits, input validation, and `/api/health`
- Render Blueprint (`render.yaml`) with a persistent disk mounted at `/var/data`

## Deploy to Render
1. Create a private GitHub repository and upload the contents of this ZIP. Do not upload `.env`, database files, or secrets.
2. In Render, choose **New + → Blueprint** and connect that repository.
3. Render reads `render.yaml`. Use a plan that supports persistent disks; this configuration uses a 1 GB persistent disk so SQLite data survives redeploys.
4. When prompted, set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` as secret environment variables.
5. Generate the password hash locally (after `npm install`):
   ```bash
   node scripts/hash-password.js
   ```
   Use a unique password of at least 12 characters. The script prints a bcrypt hash; paste only the hash into `ADMIN_PASSWORD_HASH`. Do not paste the actual password into Render as the hash value.
6. Deploy. Wait for the service to become **Live**. Test `https://YOUR-SERVICE.onrender.com/api/health` — it should return `{"ok":true}`.
7. Open the service URL to test the storefront, then test admin login and a test order before sharing the site.

Render may ask you to choose a paid instance for persistent disk support. Do not remove the disk or change `DB_PATH` to an ephemeral location for a real shop.

## Local run
Requires Node.js 20+.
```bash
npm install
cp .env.example .env
# Set JWT_SECRET, ADMIN_EMAIL, and ADMIN_PASSWORD_HASH in .env
npm start
```

## Before accepting real customers
- **Payments are not enabled.** Checkout currently creates an order with payment status `pending`. Add a gateway such as Razorpay using server-side order creation, signature verification, and verified webhooks before claiming online payment is available.
- Configure and test backups for `/var/data/shop.db`; a persistent disk is not a backup.
- Set up a custom domain only after the generated service URL works.
- Add shipping, cancellation/refund, privacy, terms, and contact policies appropriate to your business.
- Run a real end-to-end test for checkout, stock, admin access, and restore-from-backup.
- Never share your Render, GitHub, or payment-provider passwords/API secrets in chat or commit them to Git.

## Important limitations
This is a deployment-ready starter, not a fully audited commerce platform. SQLite is suitable for a small single-instance shop; use a managed PostgreSQL database and review concurrency/operational needs as the business grows. Do not scale this service to multiple instances while using a single SQLite database.
