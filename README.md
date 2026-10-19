# Web2PDF Exact

Extension pour **Zen** et **Firefox** qui convertit la page affichée en un PDF **identique à ce que vous voyez à l’écran**.

C’est le moteur de rendu du navigateur (Gecko) qui dessine la page, et ce dessin est placé tel quel dans le PDF. Rien n’est rechargé ni réinterprété : la capture part de votre onglet, avec votre session, dans l’état exact où se trouve la page.

## Les problèmes des autres extensions, et ce qui change ici

| Problème rencontré | Cause habituelle | Web2PDF Exact |
| --- | --- | --- |
| Le CSS n’est pas bien repris | La page est redessinée par une bibliothèque JavaScript (html2canvas, jsPDF…) ou passée au moteur d’impression, qui applique les styles `@media print` et une autre largeur | La page est dessinée par Gecko lui‑même via l’API de capture native du navigateur. Polices, dégradés, ombres, canvas, SVG, vidéos et iframes sortent tels qu’à l’écran. |
| Réglages pas assez libres | Format A4 imposé, pas de marge réglable, nom de fichier figé | Une quarantaine de réglages : zone, format (page unique, A4, A3, Lettre, écran, personnalisé), orientation, marges, netteté jusqu’à ×4, compression, coupures de page, en‑tête et pied de page, modèle de nom avec sous‑dossiers… |
| La conversion échoue | Pages trop longues, applications web, contenus chargés au défilement | Capture par tuiles (testée sur 60 000 px), déroulé des conteneurs défilants (messageries, Notion…), listes virtualisées, images différées, animations d’apparition, pages zoomées, pause automatique si vous changez d’onglet. |
| Le PDF montre la page de chargement ou l’anti‑robot | Le service recharge l’adresse sur un serveur, qui reçoit la page de vérification Cloudflare ou un écran de connexion | Rien n’est rechargé : la capture se fait dans votre onglet, connecté, après vos clics, avec les champs remplis et les menus ouverts. |

## Installation dans Zen

Zen accepte les extensions non signées une fois un réglage modifié. Le comportement a été vérifié sur Zen 1.23.3b (Firefox 158) : refusée par défaut, installée de façon permanente une fois le réglage changé.

1. Construisez l’archive : `sh tools/build.sh` (elle est créée dans `dist/`).
2. Dans la barre d’adresse, ouvrez `about:config`, cherchez `xpinstall.signatures.required` et passez‑le à **false**.
3. Ouvrez `about:addons`, cliquez sur la roue dentée puis **Installer un module depuis un fichier…**, et choisissez `dist/web2pdf-exact-1.0.0.xpi`.
4. Épinglez l’icône dans la barre d’outils depuis le menu des extensions.

Firefox 140 ou plus récent est requis (Zen inclus).

Autres façons d’installer :
- **Sans toucher au réglage** : `about:debugging` → *Ce Zen* → *Charger un module complémentaire temporaire…* → choisir `manifest.json`. L’extension disparaît au redémarrage du navigateur.
- **Firefox standard** (qui exige une signature) : signez l’extension en distribution non listée avec vos clés AMO, par exemple `npx web-ext sign --channel=unlisted --api-key=… --api-secret=…`.

## Publication sur la boutique Firefox (addons.mozilla.org)

La publication est gratuite. Le manifeste est déjà conforme aux règles en vigueur : il déclare l’absence de collecte de données (`data_collection_permissions`), exigée pour toute nouvelle extension depuis novembre 2025. Le code n’est ni minifié ni transpilé, donc aucune archive de sources n’est à fournir aux relecteurs. Deux modes : **listée** (visible dans la boutique, après relecture) ou **non listée** (signée pour être installée depuis votre propre lien).

## Utilisation

- **Icône** ou <kbd>Alt</kbd>+<kbd>Maj</kbd>+<kbd>P</kbd> : choisissez la zone, le format et la netteté, puis **Convertir en PDF** (ou <kbd>Entrée</kbd>). Ces choix sont mémorisés.
- **Clic droit** sur la page → *Web2PDF Exact* : page entière, zone visible, élément, zone tracée, ou version vectorielle.
- **Raccourcis directs**, sans popup : à attribuer dans `about:addons` → roue dentée → *Gérer les raccourcis d’extensions*.
- <kbd>Échap</kbd> interrompt une capture, et la page revient exactement à son état d’origine (défilement, sélection, styles).

Zones :
- **Page entière** : toute la page. Pour une application web dont le contenu défile dans un panneau, ce panneau est « déroulé ».
- **Visible** : exactement ce qui est affiché, à la position de défilement actuelle.
- **Élément** : survolez puis cliquez. <kbd>↑</kbd> sélectionne le parent, <kbd>↓</kbd> revient à l’enfant, <kbd>Entrée</kbd> valide. Un panneau défilant choisi est capturé en entier.
- **Zone** : tracez un rectangle à la souris. La molette et les bords de l’écran font défiler la page pendant le tracé.
- **Retirer des éléments avant la capture** (option) : cliquez sur ce qui gêne (bandeau de cookies, bulle de chat, publicité), <kbd>Ctrl</kbd>+<kbd>Z</kbd> pour rétablir, <kbd>Entrée</kbd> pour capturer. Rien n’est supprimé de la page : tout réapparaît après la capture.

## Ce que contient le PDF

- **L’image du rendu**, à la résolution de votre écran (×2 sur un écran Retina, ×3 avec un zoom de page à 150 %) ou plus si vous le choisissez.
- **Un calque de texte invisible**, aligné sur l’image : sélection, copier‑coller et recherche fonctionnent, y compris pour les accents, le chinois, l’arabe et les emoji. Le texte copié respecte les espaces et les retours à la ligne dans Aperçu comme dans le lecteur PDF de Zen.
- **Les liens cliquables**, externes et internes (une ancre `#section` mène au bon endroit du PDF).
- **Des signets** générés à partir des titres de la page.
- **Les métadonnées** : titre de la page, adresse source et date de capture.

Les coupures de page sont **intelligentes** : en format paginé (A4…), une coupe ne tranche jamais une ligne de texte ou une image. Le format **Page unique** (par défaut) n’a aucune coupure : le PDF est la page, d’un seul tenant.

## Comment la capture reste fidèle

1. Le contenu différé est préchargé : un premier passage fait défiler la page pour déclencher le chargement des images et des contenus paresseux.
2. La page est ensuite capturée tranche par tranche, chaque tranche étant dessinée par Gecko. Les limites de tranche tombent entre deux blocs, et le bas de l’écran (où les animations d’apparition se déclenchent en retard) est repris à la tranche suivante.
3. Les éléments fixes (en‑tête collant, bulle de chat) apparaissent une seule fois en haut, au lieu d’être répétés sur chaque tranche. Les éléments collants retrouvent leur place naturelle.
4. Les transitions et animations sont terminées instantanément, sans bloquer les scripts de la page (carrousels compris).
5. Le texte et les liens sont relevés au moment où leur tranche est capturée, ce qui les garde synchrones avec l’image, même sur une liste virtualisée.

Sur une page statique, la capture par tranches et le rendu d’un seul tenant donnent les mêmes pixels : sur 96 millions, 410 diffèrent, par l’anticrénelage de coins arrondis. Ce n’est pas visible.

## Moteur vectoriel (option)

Pour un PDF très léger à texte vectoriel, le moteur **Vectoriel** utilise l’impression PDF du navigateur. Il force les styles d’écran (les règles `@media print` de la page sont neutralisées), met en page à la largeur de l’écran puis réduit pour tenir sur le papier, et évite la répétition des éléments fixes. Limites propres à l’impression : les sections d’une hauteur d’écran (`100vh`) prennent la hauteur du papier, et les feuilles de style hébergées sur un autre domaine ne peuvent pas être adaptées. Une fenêtre demande où enregistrer le fichier.

## Limites connues

- Les pages internes du navigateur (`about:`, `addons.mozilla.org`, le lecteur PDF intégré…) sont inaccessibles à toute extension. Le mode lecture n’est convertible qu’avec le moteur vectoriel.
- Le texte situé dans une iframe d’un **autre** domaine apparaît dans l’image, mais pas dans le calque de texte.
- Les sites qui simulent le défilement par transformations CSS (ancien Locomotive Scroll) ne sont capturés que sur la partie visible.
- Les effets de parallaxe et les arrière‑plans `background-attachment: fixed` dépendent du défilement. Pour ces pages, la méthode **Rendu direct** (réglages → Capture) dessine toute la page d’un seul tenant.

## Tests

`tests/` contient une suite de bout en bout qui pilote un vrai moteur Gecko sans interface (Zen par défaut, ou Firefox avec `--binary`), sur un **profil temporaire jetable**. Le profil de l’utilisateur n’est jamais touché.

```bash
python3 tests/run_tests.py            # pages pièges locales (~10 min)
python3 tests/run_tests.py --real     # quelques sites réels (réseau requis)
python3 tests/run_tests.py --only app # un seul scénario
```

Les PDF sont vérifiés indépendamment avec PDFKit (macOS) et pdf.js (le lecteur de Zen) : nombre et taille des pages, texte extrait, liens, signets, zones non peintes, coupures de lignes, et structure interne du fichier. La suite couvre aussi les raccords entre tranches, comparés au pixel près.

## Organisation du code

| Fichier | Rôle |
| --- | --- |
| `content/agent.js` | Injecté dans l’onglet : préparation de la page, défilement, choix des coupes, relevé du texte, des liens et des titres, sélecteurs (élément, zone, nettoyage), restauration. |
| `background/background.js` | Orchestration : tâches, captures natives (`tabs.captureTab`), CSS injecté en origine utilisateur, progression, téléchargement, menus, raccourcis, moteur vectoriel. |
| `background/build.js` | Assemblage du PDF : tuiles, calque de texte, liens, signets, en‑têtes. |
| `lib/pdf.js` | Écriture PDF 1.7 sans dépendance et police invisible Unicode (CID Identity‑H + ToUnicode). |
| `lib/image.js` | Encodage JPEG ou sans perte (prédicteurs PNG + Deflate), avec choix automatique. |
| `lib/layout.js` | Formats, marges et coupures de page intelligentes. |
| `lib/settings.js`, `lib/filename.js` | Réglages et noms de fichiers (mêmes règles que le validateur de Gecko). |
| `popup/`, `options/` | Interface. |
| `tools/` | Construction de l’archive, génération de la police invisible. |

Aucune donnée ne quitte le navigateur : pas de serveur, pas de bibliothèque tierce, pas de télémétrie.

## Licence

[MIT](LICENSE).

---

<sub>Conçu avec l’aide des ressources de Wheeloh</sub>
