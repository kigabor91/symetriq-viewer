# SymetrIQ Viewer – production telepítés (Windows / IIS)

Ez az útmutató a különálló Windows 11 tesztszerverre és a későbbi Windows
Server környezetre készült. A fejlesztői gép workflow-ja változatlan marad:
ott továbbra is `npm run dev` fut. A tesztszerveren **nem** fut Vite dev
server.

## Architektúra

```text
VPN böngésző
    │ HTTPS + HTTP/2
    ▼
IIS
 ├─ viewer/dist                 React/Vite statikus felület
 ├─ /project-files              közvetlen IIS statikus fájlkiszolgálás
 │   └─ XKT, LAS/LAZ, GLB, JSON, JPG/WebP, issue-képek
 └─ /api                        localhost reverse proxy
        ▼
    SymetrIQ Converter Node szolgáltatás :3001
        └─ projektadatok, feltöltés, IFC/E57 konverzió
```

A nagy viewer-fájlok nem mennek át a Node folyamaton: az IIS közvetlenül,
byte-range támogatással szolgálja ki őket. Ez különösen VPN-en fontos.

## Mit kell telepíteni a szerverre

1. Node.js LTS (a fejlesztői géppel azonos főverzió ajánlott).
2. Python 3.12 vagy 3.13. A `python --version` parancsnak működnie kell.
   A jelenlegi E57 feldolgozó `numpy` és `pye57` csomagokat használ.
3. IfcOpenShell `IfcConvert.exe`, a converter `tools/ifcopenshell` mappájába
   vagy az `IFCCONVERT_PATH` környezeti változóban megadva.
4. IIS:
   - Web Server / Static Content;
   - HTTP Compression;
   - IIS Management Console.
5. IIS URL Rewrite és Application Request Routing (ARR). Az ARR telepítése
   után az IIS Managerben: **Application Request Routing Cache → Server Proxy
   Settings → Enable Proxy**.
6. Microsoft **IIS Compression** x64 kiegészítő. Ez adja a Brotli (`br`) és a
   korszerű Gzip providerét. A [Microsoft dokumentáció](https://learn.microsoft.com/en-us/iis/extensions/iis-compression/iis-compression-overview)
   leírja a telepítést és a szükséges IIS compression modulokat.

> Fontos: az IIS `maxAllowedContentLength` technikai felső korlátja 4 GiB.
> A mostani production proxy ezért böngészős feltöltésnél 4 GiB-ig támogatja
> a fájlokat (a converter saját 20 GiB védelmi korlátja ettől még megmarad).
> 4 GiB feletti E57-ekhez később külön, chunkolt/resumable feltöltési végpontot
> kell bevezetnünk; ezt a jelenlegi frontend funkcionalitás változtatása nélkül
> nem lehet IIS-en át korlátlanra állítani.

Windows Serveren az IIS szerepkör PowerShellből is telepíthető:

```powershell
Install-WindowsFeature Web-Server, Web-Static-Content, Web-Http-Compression, Web-Mgmt-Console
```

Windows 11-en az **Turn Windows features on or off** felületen az *Internet
Information Services → World Wide Web Services → Performance Features → Static
Content Compression* elemet kell engedélyezni.

## Első telepítés

A példában a célmappa `C:\SymetrIQ`.

1. Másold fel a két repositoryt:

```text
C:\SymetrIQ\symetriq-viewer
C:\SymetrIQ\symetriq-converter
```

   A converter `data` mappáját ne írd felül későbbi frissítéskor: ez tartalmazza
   a projekteket és a feltöltött/konvertált fájlokat.

2. Telepítsd a Node függőségeket és építsd le a két production csomagot:

```powershell
cd C:\SymetrIQ\symetriq-converter
npm.cmd ci
npm.cmd run build

cd C:\SymetrIQ\symetriq-viewer\viewer
npm.cmd ci
npm.cmd run build:production
```

   A Viewer eredménye: `C:\SymetrIQ\symetriq-viewer\viewer\dist`.
   A Converter eredménye: `C:\SymetrIQ\symetriq-converter\dist-server`.

3. A Python-csomagokat a szerver Python környezetébe telepítsd:

```powershell
python -m pip install --upgrade pip
python -m pip install numpy pye57
```

4. A `npm run build:production` automatikusan a Viewer `dist` mappájába
   másolja a production `web.config` fájlt.

5. IIS Managerben hozz létre egy **SymetrIQ Viewer** webhelyet:

   - Physical path:
     `C:\SymetrIQ\symetriq-viewer\viewer\dist`
   - Binding: a céges DNS név; éles/VPN teszthez **HTTPS** tanúsítvánnyal.
     IIS HTTP/2 HTTPS kapcsolaton működik Windows 10 / Server 2016+ alatt,
     amennyiben a kliens is támogatja.
   - Add Virtual Directory:
     - Alias: `project-files`
     - Physical path: `C:\SymetrIQ\symetriq-converter\data\projects`

6. Az IIS alkalmazáskészletének legyen olvasási joga mindkét könyvtárhoz,
   a Node szolgáltatást futtató fióknak pedig írási joga a teljes
   `C:\SymetrIQ\symetriq-converter\data` mappához.

7. Indítsd a Converter API-t egy külön PowerShellben az első ellenőrzéshez:

```powershell
cd C:\SymetrIQ\symetriq-converter
npm.cmd run start:production
```

   Várt üzenet:

```text
SymetrIQ project server listening on http://localhost:3001
```

   Ellenőrzés:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/projects
```

   A végleges működéshez a `deployment\start-production-api.cmd` fájlt
   állítsd be Windows Task Schedulerben **At startup** triggerrel, vagy
   futtasd NSSM-mel Windows szolgáltatásként. A szolgáltatás fiókja ugyanaz a
   felhasználó legyen, amelynél az `IfcConvert` és a Python elérhető.

8. Nyisd meg a webhely HTTPS címét. A DevTools Network panelben az
   `/api/projects` kérésnek 200 választ, egy XKT/LAS kérésnek pedig közvetlen
   IIS-választ kell adnia.

## Teljesítmény és cache stratégia

| Tartalom | Kiszolgáló | Cache | Tömörítés |
| --- | --- | --- | --- |
| `index.html` | IIS | nincs; minden deploy után újraellenőrződik | Brotli/Gzip |
| Vite JS/CSS (`assets/*-hash.*`) | IIS | 1 év | Brotli/Gzip |
| XKT / GLB | IIS `/project-files` | 1 év; a `?v=revision` verziózza | nincs – bináris / gyakran már tömörített |
| LAS / LAZ | IIS `/project-files` | 1 év; a `?v=revision` verziózza | nincs – a LAZ eleve tömörített, Range-barát |
| metadata JSON | IIS `/project-files` | 1 év; `?v=revision` verziózza | Brotli/Gzip |
| panoráma JPG/WebP, thumbnail, issue-kép | IIS `/project-files` | 1 év; fájlnév vagy revision változik | nincs – képek eleve tömörítettek |

Az IIS web.config a LAS/LAZ/XKT MIME típusokat is beállítja. A GLB MIME típust
a modern IIS alapértelmezetten ismeri. Az IIS
statikus fájlkiszolgálása támogatja a `Range` kéréseket; ez különösen alkalmas
nagy objektumok folytatható átvitelére. Nem szabad HTTP-szinten tömöríteni a
LAS/LAZ és JPEG fájlokat, mert ez CPU-t fogyasztana és ronthatná a byte-range
viselkedést.

A Keep-Alive IIS-ben alapértelmezetten engedélyezett. HTTPS mellett az HTTP/2
egyetlen kapcsolaton multiplexeli a párhuzamos asset-kéréseket. A Brotli és
Gzip sorrendjét az IIS Compression provider `br`, majd `gzip` sorrendjével
állítsd be a Microsoft [használati útmutatója](https://learn.microsoft.com/en-us/iis/extensions/iis-compression/using-iis-compression)
szerint.

## Panorámák

A Viewer nem tölti le automatikusan a panorámaképeket projekt/scene nyitásakor.
Ekkor csak a projekt API-válaszában lévő scannerállás-metaadatok (pozíció,
név, hat face URL) és a scene markerek jönnek le. A hat nagy felbontású JPEG
face kizárólag akkor töltődik le, amikor a felhasználó a scanner markerére
kattintva ténylegesen megnyitja a panorámát. Ez a jelenlegi működés, nem igényel
külön production kapcsolót.

## Frissítés a fejlesztői gépről

1. Fejlesztői gépen ellenőrizd:

```powershell
cd C:\Development\symetriq-converter
npm.cmd run typecheck

cd C:\Development\symetriq-viewer\viewer
npm.cmd run build
```

2. Másold fel a módosult repository-fájlokat a szerverre. Ne másold fel a
   `node_modules`, `data` vagy a régi `dist` mappákat.
3. Ha `package.json` vagy `package-lock.json` változott, futtasd a megfelelő
   repositoryban az `npm.cmd ci` parancsot.
4. Építs újra:

```powershell
cd C:\SymetrIQ\symetriq-converter
npm.cmd run build

cd C:\SymetrIQ\symetriq-viewer\viewer
npm.cmd run build:production
```

5. A Viewer `dist` mappa cseréje után az `index.html` cache tiltása miatt a
   felhasználók a következő megnyitás/frissítéskor az új, hash-elt JS/CSS
   fájlokat kapják. A korábbi cache-ből nem lesz régi build.
6. Converter-kód módosításakor indítsd újra a Node szolgáltatást. A folyamatban
   lévő konvertálást előbb hagyd befejeződni vagy állítsd le kontrolláltan.

## Docker értékelés

Később megvalósítható egy Docker image a Node API + Python/pye57 környezethez,
de az első Windows production körben nem ajánlott kötelezővé tenni. A natív
Windows `IfcConvert.exe`, a több tíz GB-os projekttároló és az IIS Windowsos
integráció miatt a Docker kezdetben inkább plusz hibaforrás lenne. Az API és a
statikus webhely most már elkülönül, ezért később az API konténerbe helyezése
nem igényli a Viewer átírását; az IIS akkor is ugyanúgy proxyzhatja az `/api`
végpontot és kiszolgálhatja a `project-files` virtuális könyvtárat.
