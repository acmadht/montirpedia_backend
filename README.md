# MontirPedia Backend DOKU

Backend ini untuk tahap DOKU real payment.

## Endpoint

### 1. POST `/api/create-doku-transaction`

Dipanggil dari Flutter saat customer menekan tombol **Bayar dengan DOKU**.

Response utama:

```json
{
  "ok": true,
  "paymentUrl": "https://...",
  "invoiceNumber": "MP-..."
}
```

Frontend akan membuka `paymentUrl` di WebView.

### 2. POST `/api/doku-notification`

Dipanggil oleh DOKU setelah customer membayar. Endpoint ini update Firestore:

- `paymentStatus`
- `statusOrder`
- `status`
- `paidAt`
- `dokuRawNotification`

## File yang disalin

Salin semua isi folder ini ke folder `montirpedia_backend`.

```text
montirpedia_backend/
├── api/
│   ├── create-doku-transaction.js
│   └── doku-notification.js
├── lib/
│   ├── doku.js
│   └── firebaseAdmin.js
├── package.json
├── vercel.json
└── .env.example
```

## Environment minimal

```env
DOKU_CLIENT_ID=MCH-xxxxxxxxxxxxxxxx
DOKU_SECRET_KEY=isi_secret_key_production
DOKU_BASE_URL=https://api.doku.com
DOKU_NOTIFICATION_URL=https://domain-backend-kamu.com/api/doku-notification
DOKU_NOTIFICATION_TARGET=/api/doku-notification
DOKU_CALLBACK_URL=https://domain-kamu.com/payment-result
DOKU_PAYMENT_DUE_DATE_MINUTES=60
FIREBASE_SERVICE_ACCOUNT_BASE64=isi_base64_service_account_json
REQUIRE_FIREBASE_AUTH=false
DOKU_SKIP_SIGNATURE_VERIFY=false
```

## Install

```bash
npm install
npm run lint
```

## Jalankan lokal

```bash
npx vercel dev
```

## Deploy Vercel

```bash
vercel --prod
```

Setelah deploy, copy domain backend ke Flutter:

```dart
static const String backendBaseUrl = 'https://domain-backend-kamu.vercel.app';
```

File yang biasanya menyimpan backend URL di project kamu:

```text
lib/services/service_notification_sender.dart
```

## Catatan penting

1. Jangan taruh `DOKU_SECRET_KEY` di Flutter.
2. Jangan pakai sandbox kalau mau transaksi asli.
3. Pastikan `DOKU_NOTIFICATION_URL` sama dengan URL endpoint production kamu.
4. Kalau signature webhook gagal, cek `DOKU_NOTIFICATION_TARGET`. Nilainya harus sama dengan path URL webhook, contoh `/api/doku-notification`.
5. Untuk debugging singkat, bisa set `DOKU_SKIP_SIGNATURE_VERIFY=true`, tetapi jangan dipakai di production.
