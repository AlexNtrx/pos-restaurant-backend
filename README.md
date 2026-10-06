# Ravintola POS – Backend

Ravintolan kassamyynnin, QR-tilausten ja keittiön työnkulun API. Tämä portfolio-projekti näyttää, miten käyttäjän oikeudet, tilaukset ja maksut käsitellään palvelinpuolella.

**Lähdekoodiversio: [v2.0.1](https://github.com/AlexNtrx/pos-restaurant-backend/releases/tag/v2.0.1)** · [Frontend](https://github.com/AlexNtrx/pos-restaurant-nextjs) · [Frontend-sovellus](https://pos-restaurant-nextjs.vercel.app)

## Toiminnot

- Henkilökunnan kirjautuminen ja roolit `admin`, `kassa`, `waiter` ja `kitchen`.
- Kassa-, QR- ja tarjoilijatilaukset, pöytäistunnot ja asiakkaan palvelupyynnöt.
- Keittiökäsittely, tilausversiot ja tilamuutosten historia.
- Maksut, PDF-kuitit, kuittihistoria ja myyntiraportit.
- Valmistusta edeltävät peruutukset ja manuaalisten rahapalautusten kirjaus.
- Ruokalistan, henkilökunnan ja ravintolan asetusten hallinta sekä rajatut kuvalataukset ja kuvavariantit.

## Teknologiat ja suunnitteluratkaisut

Node.js 24, Express 5, Prisma 5, PostgreSQL, JWT, PDFKit ja Sharp.

- **Taloudelliset arvot palvelimelta:** frontendin hintoihin, summiin tai käyttöoikeusväitteisiin ei luoteta.
- **Transaktiot ja idempotenssi:** maksu ja siihen liittyvät kirjaukset käsitellään yhdessä; saman pyynnön uusinta palauttaa aiemman tuloksen.
- **Tilausversiot:** vanhentunut tilamuutos hylätään, jotta kaksi laitetta eivät voi vahvistaa samaa muutosta.
- **Tilausten snapshotit:** historia ja kuitit säilyttävät tilaushetken tiedot ruokalistan myöhemmistä muutoksista riippumatta.
- **Erillinen palautuskirjaus:** alkuperäinen lasku säilyy ja palautus vaatii ylläpitäjän vahvistuksen. API ei toteuta pankki- tai maksupalvelusiirtoa.
- **Rajattu tiedonsiirto:** kuittihistoria sivutetaan, raportit aggregoidaan tietokannassa ja kuvien käsittelyllä on koko- ja rinnakkaisuusrajat.

## Rakenne

```text
server.js       runtime, yhteiset middlewaret ja reittien rekisteröinti
routes/         domainin reitit ja middlewarejärjestys
middleware/     tunnistautuminen, oikeudet ja upload-raja
controller/     HTTP-pyynnöt, vastaukset ja virheiden muunnos
lib/            validaatio, domainpalvelut, lukumallit ja apufunktiot
prisma/         schema ja migraatiot
test/           API- ja regressiotestit
```

Pyynnön kulku: **Route → Authentication/Permissions → Controller → Service → Prisma**.

| Muutettava alue                       | Sijainti                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Order submit, tilamuutos ja maksu     | `lib/order-submission-service.js`, `order-transition-service.js`, `order-settlement-service.js`             |
| Kassatilaukset ja vaihtoehtojen luku  | `lib/counter-order-service.js`, `counter-read-service.js`                                                   |
| Vanha ostoskori, checkout ja kuitit   | `lib/legacy-cart-service.js`, `legacy-checkout-service.js`, `legacy-receipt-service.js`                     |
| Kirjautuminen ja henkilöstö           | `lib/authentication-service.js`, `staff-user-service.js`                                                    |
| Pöytäistunnot, QR ja pöytien ylläpito | `lib/table-service.js`, `table-admin-service.js`                                                            |
| Peruutukset ja palautukset            | `lib/order-refund-service.js`, `bill-cancellation-service.js`                                               |
| Ruokalistan kirjoitukset              | `lib/category-write-service.js`, `size-write-service.js`, `taste-write-service.js`, `food-write-service.js` |

`lib/order-service.js` säilyttää yhteensopivan export-rajapinnan; varsinaiset työnkulut ovat yllä olevissa palveluissa.

## Asennus ja ympäristö

Tarvitset Node.js 24:n, npm:n, PostgreSQL:n ja oikeudet paikalliseen kehitystietokantaan.

```bash
git clone https://github.com/AlexNtrx/pos-restaurant-backend.git
cd pos-restaurant-backend
npm ci
```

Kopioi `.env.example` tiedostoksi `.env` ja aseta omat arvot:

```dotenv
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/db_next_workshop_pos?schema=public
DIRECT_URL=postgresql://USER:PASSWORD@localhost:5432/db_next_workshop_pos?schema=public
SECRET_KEY=REPLACE_WITH_A_RANDOM_SECRET
QR_TOKEN_SECRET=REPLACE_WITH_AN_INDEPENDENT_64_HEX_CHARACTER_SECRET
CORS_ORIGINS=http://localhost:3000
```

Luo JWT- ja QR-salaisuudet erikseen. QR-avain on 64 heksadesimaalimerkkiä ja pysyy samana käyttöönottojen välillä.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Älä lisää oikeita tunnuksia tai `.env`-tiedostoja versionhallintaan.

## Tietokanta ja ensimmäinen ylläpitäjä

Luo ensin paikallinen kehitystietokanta ja varmista yhteysosoitteiden kohde.

```bash
npm run build
npm run db:validate
npm run db:migrate:deploy
```

`build` generoi Prisma Clientin. Migraatiokomento käyttää olemassa olevia migraatioita eikä nollaa tietokantaa. Älä ohita migraatiovirhettä resetillä.

Tyhjä `User`-taulu voidaan alustaa yhdellä ylläpitäjällä. Aseta `.env`-tiedostoon `FIRST_ADMIN_EXPECTED_DATABASE`, `FIRST_ADMIN_EXPECTED_HOST`, `FIRST_ADMIN_NAME`, `FIRST_ADMIN_USERNAME` ja `FIRST_ADMIN_PASSWORD` (16–128 merkkiä).

```bash
npm run admin:first
```

Kuivaharjoitus tarkistaa kohteen. Luo tili vain oikeaan paikalliseen tietokantaan:

```bash
npm run admin:first -- --apply
```

Komento ei korvaa olemassa olevia tilejä. Poista tilapäiset provisioning-arvot paikallisesta ympäristöstä käytön jälkeen.

## Käynnistys ja testit

```bash
npm start
```

Oletusportti on `3001`. API-reitit alkavat polusta `/api`; henkilökunnan pyynnöt käyttävät Bearer-tokenia ja asiakkaan QR-pyynnöt pöytäistunnon tokenia.

Testit muuttavat tietokantaa. Kopioi `.env.test.example` tiedostoksi `.env.test` ja aseta erillinen loopback-testikohde:

```dotenv
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/db_next_workshop_pos_test?schema=public
```

Sallittu nimi on `db_next_workshop_pos_test` tai nimi, jonka loppuosa on `_` ja pieniä kirjaimia, numeroita tai alaviivoja. Testityökalut hyväksyvät vain loopback-hostin ja `public`-scheman. Valmistelu tarvitsee oikeuden luoda testitietokanta, jos sitä ei vielä ole.

```bash
npm run test:db:prepare
npm run test:db:validate
npm test
npm run format:check
```

Refaktorointivaiheessa **150 regressiotestiä** läpäisi tarkistukset disposable-tietokannassa. Prisma-validaatio, JavaScript-syntaksi ja muutettujen tiedostojen Prettier-tarkistus läpäisivät tarkistukset. Tämä ei vahvista tuotannon selain-E2E- tai pilot-hyväksyntää.

## Päivitys versiosta v2.0.0

Tämä julkaisu sisältää myös ennen refaktorointia toteutetut refund- ja kassa-roolimuutokset. Varmuuskopioi kohde ja suorita migraatiot ennen yhteensopivan frontend/backend-parin käyttöönottoa:

- `20261002190000_order_refunds` lisää palautusten kirjaustaulukon.
- `20261002200000_kassa_role` muuttaa tallennetun `user`-roolin `kassa`-rooliksi säilyttäen käyttäjät ja historiaviitteet.

Aiempi `user`-rooli ei ole enää hyväksytty kassaoikeus. Kassalla ei ole keittiön valmistusoikeuksia. Uudelleenjulkaistava frontend ja backend on otettava käyttöön yhdessä; tuotannon migraatiot edellyttävät erillistä hyväksyttyä suunnitelmaa.

## Rajaukset ja tila

- Yksi ravintola; ei monen ravintolan tenant-mallia.
- Pöytäistunnolla yksi lasku; ei laskun jakamista tai osamaksuja.
- Tilausten päivitys kyselyillä, ei realtime-yhteydellä.
- Ei verkkomaksuja, toimituksia, varastonhallintaa, pöytävarauksia tai kanta-asiakasohjelmaa.

Lähdekoodijulkaisu ei yksin vahvista tuotantovalmiutta. Tuotantotarkistukset ja pilotin hyväksyntä ovat kesken; refaktorointierälle ei tehty uutta selain-E2E-tarkistusta. Ennen käyttöönottoa tarkista migraatiot, CORS, pysyvä uploads-tallennus ja API-yhteydet.

Yhteensopiva pari: [Backend v2.0.1](https://github.com/AlexNtrx/pos-restaurant-backend/releases/tag/v2.0.1) · [Frontend v2.0.1](https://github.com/AlexNtrx/pos-restaurant-nextjs/releases/tag/v2.0.1).
