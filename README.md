# Ravintola POS – Backend

Ravintola POS yhdistää kassamyynnin, pöytäkohtaiset QR-tilaukset ja keittiön tilausten käsittelyn samaan työnkulkuun.

Backend tarjoaa frontendille API:n ja tarkistaa palvelinpuolella käyttäjän, käyttöoikeudet, tuotteiden saatavuuden, hinnat, summat ja tilausten sallitut muutokset.

- [Frontend repository](https://github.com/AlexNtrx/pos-restaurant-nextjs)
- [Backend-julkaisut](https://github.com/AlexNtrx/pos-restaurant-backend/releases)
- [Frontend-julkaisut](https://github.com/AlexNtrx/pos-restaurant-nextjs/releases)

## Toiminnot

- Henkilökunnan kirjautuminen ja roolikohtaiset käyttöoikeudet.
- Kassa-, QR- ja tarjoilijatilaukset sekä pöytäistunnot.
- Keittiön tilauskäsittely, tilaushistoria ja palvelupyynnöt.
- Maksut, kuitit, peruutusten kirjaus ja raportit.
- Ruokalistan, henkilökunnan ja ravintolan asetusten hallinta.

Frontendin lähettämiin hintoihin tai loppusummiin ei luoteta; backend laskee taloudelliset arvot itse.

## Teknologiat ja vaatimukset

Node.js 24, Express 5, Prisma 5, PostgreSQL, JWT ja PDFKit.

Tarvitset PostgreSQL-tietokannan ja oikeudet valitun paikallisen tietokannan käyttöön.

## Asennus ja ympäristö

```bash
git clone https://github.com/AlexNtrx/pos-restaurant-backend.git
cd pos-restaurant-backend
npm ci
```

Luo `.env` projektin juureen. Käytä omia arvoja äläkä lisää tiedostoa versionhallintaan.

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/pos_local?schema=public
SECRET_KEY=REPLACE_WITH_A_RANDOM_SECRET
QR_TOKEN_SECRET=REPLACE_WITH_64_HEXADECIMAL_CHARACTERS
```

Luo salaisuudet erikseen tällä komennolla. `QR_TOKEN_SECRET`-arvon on oltava 64 heksadesimaalimerkkiä ja sen on pysyttävä samana käyttöönottojen välillä.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Tietokannan valmistelu

Varmista ensin, että `DATABASE_URL` osoittaa hyväksyttyyn paikalliseen kehitystietokantaan.

```bash
npm run build
npm run db:validate
npm run db:migrate:deploy
```

Älä nollaa olemassa olevaa tietokantaa migraatiovirheen ohittamiseksi. Tuotantotietokantoihin tarvitaan erillinen varmuuskopiointi- ja migraatiosuunnitelma.

## Ensimmäisen ylläpitotilin luonti

Tyhjä tietokanta tarvitsee ylläpitotilin ennen hallintatoimintojen käyttöä. Aseta `.env`-tiedostoon `FIRST_ADMIN_EXPECTED_DATABASE`, `FIRST_ADMIN_EXPECTED_HOST`, `FIRST_ADMIN_NAME`, `FIRST_ADMIN_USERNAME` ja `FIRST_ADMIN_PASSWORD`. Salasanan on oltava 16–128 merkkiä.

Tarkista ensin tietokantakohde kuivaharjoituksella:

```bash
npm run admin:first
```

Luo tili vasta, kun tulos vahvistaa oikean tietokannan. Komento luo tilin vain, jos `User`-taulu on tyhjä:

```bash
npm run admin:first -- --apply
```

Käytä toimintoa vain hyväksytyssä paikallisessa ympäristössä. Älä tallenna oikeita tunnuksia versionhallintaan.

## Käynnistys ja testit

Käynnistä API portissa `3001`:

```bash
npm start
```

API-reitit alkavat polusta `/api`. Henkilökunnan pyynnöt vaativat Bearer-tokenin; asiakkaan QR-toiminnot käyttävät pöytäistunnon tokenia.

Testit muuttavat tietokantaa. Aja ne vain hyväksytyssä erillisessä testitietokannassa:

```bash
npm run test:db:prepare
npm run test:db:validate
npm test
npm run format:check
```

## Rajaukset ja julkaisu

- Järjestelmä tukee yhtä ravintolaa; usean ravintolan käyttöä ei ole toteutettu.
- Pöytäistunnolla on yksi lasku; laskun jakamista ei ole toteutettu.
- Tilauspäivitykset käyttävät kyselyitä reaaliaikaisen toimituksen sijaan.
- Verkkomaksuja, toimituksia, varastonhallintaa, pöytävarauksia ja kanta-asiakasohjelmaa ei ole toteutettu.

`v2.0.0` on julkaistu lähdekoodiversio. Tuotantotarkistukset ja pilotin hyväksyntä ovat vielä kesken. Ennen tuotantokäyttöä tarkista migraatiot, CORS, pysyvä tiedostotallennus ja API-yhteydet.
