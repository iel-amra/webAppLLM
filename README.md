# LFM3 de poche

Une app web qui fait tourner le modèle **LFM3-1.7B** de Liquid AI directement sur ton iPhone, même sans connexion. Tu n'as besoin ni de Mac, ni de compte développeur Apple, ni de l'App Store.

## 1. Mettre l'app en ligne (gratuit, 5 minutes, depuis un PC)

L'app est servie par GitHub Pages depuis la branche `main` de ce dépôt :

1. Sur GitHub, va dans **Settings**, puis **Pages**. Dans « Branch », choisis **main** et **/ (root)**, puis clique sur **Save**.
2. Attends 1 à 2 minutes. L'adresse de l'app s'affiche alors en haut de la page : `https://iel-amra.github.io/webAppLLM/`.

Chaque `git push` sur `main` met le site à jour automatiquement. Sur l'iPhone, ferme puis rouvre l'app pour recevoir la nouvelle version.

> GitHub Pages gratuit demande un dépôt **public**.

## 2. L'installer sur l'iPhone

1. Ouvre cette adresse dans **Safari**. Les autres navigateurs ne permettent pas l'ajout à l'écran d'accueil sur iPhone.
2. Touche **Partager**, puis **Sur l'écran d'accueil**.
3. Ouvre l'app depuis sa nouvelle icône.
4. En **Wi-Fi**, touche **Télécharger le modèle** (environ 1,4 Go) et garde l'écran allumé jusqu'à la fin.

C'est prêt. À partir de là, l'app fonctionne aussi en mode avion.

## 3. L'utiliser sur PC (Chrome, Edge)

1. Ouvre l'adresse de l'app dans Chrome ou Edge.
2. Facultatif : clique sur **Installer l'app** (ou sur l'icône ⊕ dans la barre d'adresse) pour l'avoir dans sa propre fenêtre.
3. Choisis la version du modèle et télécharge-la une fois.

Les trois versions :
- **Standard** ou **Allégée** : utilisent la carte graphique (WebGPU). Elles sont rapides. WebGPU est activé par défaut dans Chrome sous Windows et macOS.
- **Processeur** : fonctionne sans WebGPU, sur presque tous les PC, mais plus lentement. L'app la propose d'office si WebGPU manque.

**Sous Linux**, Chrome n'active pas encore WebGPU par défaut. Pour utiliser la carte graphique :
1. Ouvre `chrome://flags/#enable-unsafe-webgpu`, passe l'option sur **Enabled** et relance Chrome.
2. Vérifie dans `chrome://gpu` que WebGPU est bien actif. Il faut que les pilotes Vulkan soient installés, par exemple avec `sudo apt install mesa-vulkan-drivers` pour Intel ou AMD.

Sinon, le mode Processeur marche directement.

## Bon à savoir

- **Configuration nécessaire :** un iPhone récent sous iOS 26 ou plus, pour WebGPU. Plus l'iPhone a de mémoire, mieux c'est.
- **Si l'app plante ou se recharge pendant le chargement**, c'est que l'iPhone manque de mémoire. Ferme les autres apps, puis choisis la version **Allégée** (environ 0,9 Go) via ••• > *Changer de version du modèle*.
- **Le chargement à chaque ouverture** prend quelques secondes : il faut mettre le modèle en mémoire. C'est normal.
- **Le mode réflexion**, dans les réglages, fait raisonner le modèle avant de répondre. C'est plus lent, mais parfois meilleur sur les questions difficiles.
- **Pour libérer de la place :** ••• > *Supprimer le modèle de l'appareil*.
- **LFM3 est un petit modèle.** Il est rapide et privé, mais il peut se tromper, surtout sur des faits précis.
- **Licence du modèle :** LFM Open License v1.0 de Liquid AI. L'usage personnel est libre.

## Comment ça marche (pour les curieux)

- `engine.js` charge LFM3 avec Transformers.js 4.3.2 sur WebGPU (format ONNX quantifié en 4 bits).
- `worker.js` fait tourner le moteur en arrière-plan pour que l'interface reste fluide.
- `sw.js` est un service worker : il garde l'app et le moteur sur le téléphone. Le modèle, lui, est stocké par Transformers.js dans le cache du navigateur.
- Les conversations sont enregistrées uniquement sur l'appareil.
