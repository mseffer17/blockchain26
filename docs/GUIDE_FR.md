# Guide de l'équipe (FR)

Ce guide explique comment lancer le projet, comment faire la démo et comment répondre aux questions du jury.

## 1. Installation (15 minutes)

**Prérequis**

- **Node.js 22.12 ou plus récent** : `node -v` pour vérifier.
- **Foundry** (Solidity) : `curl -L https://foundry.paradigm.xyz | bash` puis `foundryup`.
- Sous Windows, utilisez **WSL2** (Ubuntu) : Foundry y fonctionne sans souci.
- VS Code, avec les extensions recommandées que VS Code propose à l'ouverture du dossier.

**Commandes, à la racine du projet**

```bash
npm install               # installe tout, y compris les dépendances Solidity
npm run build:contracts   # compile les contrats (forge build)
npm run test:contracts    # 92 tests doivent passer
npm run dev               # lance tout : chaîne locale, contrats, 6 services, app, app de secours
```

**Ce qui s'ouvre**

- App (téléphone de Claire) : http://localhost:5173
- Second téléphone : http://localhost:5173/?device=new-phone
- Boîte aux lettres de Claire : http://localhost:5173/#/mailbox
- Back-office (agents, Swissquote, La Poste, gas station, watchtower, horloge de la chaîne) : http://localhost:5173/#/ops
- App de secours (sans Swissquote) : http://localhost:5174

Pour repartir de zéro : `npm run dev -- --fresh`.

**Pas de Face ID sur le portable de démo ?** Choisissez « Use the demo authenticator ». Les signatures sont les mêmes ;
la clé est simplement gardée dans le navigateur.

## 2. Comment c'est construit (pour en parler avec assurance)

**`contracts/src/RutliAccount.sol` : le pacte**

- C'est un compte ERC-4337 à 4 facteurs : passkey P, carte C, Swissquote S, La Poste G.
- La fonction `canAuthorize(selector, facteurs)` *est* la règle. Elle est publique et lue en direct par l'écran
  « Radiographie ».
- Face ID seul ne peut utiliser que `spend` (plafond journalier, vérifié à l'exécution).
- Les délais de récupération (S+G) et de sortie (carte seule) sont dans le contrat, et le client peut les annuler.
- Aucune cryptographie maison : OpenZeppelin `WebAuthn`, `P256`, `ECDSA`, `EIP712`.

**Les autres contrats**

- `RutliFactory.sol` : des clones non modifiables. L'adresse dépend de toutes les clés, donc personne ne peut la squatter.
- `RutliPaymaster.sol` : Swissquote paie le gas, avec une signature liée à une opération précise et limitée dans le temps.

**Les services mockés (`services/src/`)** tournent chacun dans leur propre processus, avec leurs propres clés et leur
propre stockage, dans `services/data/` :

- `sq-core` : banque, KYC, registre Travel Rule, notifications, credential SD-JWT.
- `sq-cosigner` : la clé S et les règles (sanctions, liste de dApps, simulation, délai de 24 h pour un nouveau
  destinataire).
- `poste-guardian` : la clé G et les lettres.
- `video-ident` : attestation signée de vidéo-identification.
- `gas-station` : bundler et paymaster.
- `watchtower` : alertes, et finalise les récupérations arrivées à échéance.

**Les apps**

- `app/` : l'app React.
- `exit-app/` : un seul fichier HTML qui ne parle qu'à la blockchain.

**Les tests**

- `npm run test:contracts` : unitaires, matrice exhaustive, fuzzing, invariants, l'histoire complète.
- `npm run e2e` : toute l'histoire via les API, avec `npm run dev -- --no-app` lancé dans un autre terminal.
- `npm run test:ui` : toute l'histoire dans Chromium avec une vraie passkey virtuelle, avec captures d'écran.

## 3. Script de démo (5 minutes)

Suivez [DEMO.md](DEMO.md). Points clés à dire :

1. « Le voleur repart avec le porte-monnaie, comme un vrai portefeuille. Le coffre exige une deuxième clé. »
2. « Bloquer est facile, débloquer est difficile. »
3. « Le meilleur facteur d'authentification suisse, c'est le facteur : la lettre arrive dans la boîte aux lettres,
   pas dans l'e-mail du voleur. »
4. « On éteint Swissquote. La cliente récupère quand même ses fonds avec sa carte papier et un nœud public. »
5. « Swissquote seul ne peut rien. Swissquote + La Poste ne peuvent que lancer une demande publique de 7 jours que
   Claire annule d'un Face ID. Ce n'est pas une promesse : c'est du code que personne ne peut modifier. »

## 4. Questions probables du jury (et réponses)

**Pourquoi un contrat maison plutôt que Safe + modules ?**

- Nos règles ont des délais différents selon la combinaison de facteurs, et des annulations asymétriques. Les modules
  existants (Candide, Zodiac) le permettent mal ou dépendent de déploiements absents sur testnet.
- Un seul contrat lisible, testé de manière exhaustive, est plus facile à auditer qu'un empilement de modules.
- Aucune crypto maison : uniquement OpenZeppelin.
- En production : audit, et possible portage vers des modules ERC-7579.

**Carte + Swissquote peuvent remplacer la passkey immédiatement : n'est-ce pas risqué ?**

- C'est le cas « téléphone perdu ». Il faut agir vite pour éjecter le voleur.
- Swissquote n'ajoute sa signature qu'après une vidéo-identification signée par un prestataire indépendant.
- Un cambrioleur qui a la carte doit en plus tromper la vidéo-identification.

**Et si la passkey synchronisée iCloud est volée ?**

C'est l'équivalent du vol du téléphone : le plafond journalier, le délai sur les nouveaux destinataires et le gel la
limitent.

**Et Bitcoin ?**

- Le même pacte s'écrit en Miniscript : multisig 2-sur-3 ou carte seule après un délai (comme le wallet Liana).
- On n'a pas besoin de MPC pour être multi-chaînes. Feuille de route dans [SECURITY.md](SECURITY.md).

**Qui paie le gas, et comment éviter les abus ?**

- Swissquote paie, via le dépôt du paymaster.
- Seuls les wallets Rütli sont sponsorisés, avec un quota mensuel.
- Les opérations qui échoueraient sont simulées puis refusées, et les adresses sous sanctions sont refusées.
- Les opérations de sécurité sont toujours gratuites.

**Est-ce de la custody ?**

- Non : Swissquote ne peut ni déplacer les fonds, ni empêcher la cliente de partir.
- La zone grise S+G est retardée, publique et annulable. Voir [LEGAL.md](LEGAL.md).

**Travel Rule : quand Claire paie un tiers, Swissquote est-il l'institution émettrice ?**

- Non : c'est Claire qui signe et diffuse.
- Si le destinataire est une plateforme régulée, Claire présente le credential de propriété (SD-JWT) émis par Swissquote.

## 5. Ce qui est simulé (à dire honnêtement)

- La banque, la vidéo-identification, La Poste et le bundler sont des mocks, chacun séparé avec son propre stockage.
- La blockchain, les contrats, les passkeys, la carte, le paymaster et l'app de secours sont réels.
- Les délais sont en secondes dans la démo, en jours en production.

## 6. Dépannage

| Problème | Solution |
|---|---|
| `anvil: command not found` | installer Foundry (`foundryup`) et rouvrir le terminal |
| L'app affiche « Waiting for the Swissquote services » | `npm run dev` n'est pas lancé, ou un port (4000–4500, 5173, 5174, 8545) est déjà pris |
| Face ID ne se déclenche pas | utiliser « Use the demo authenticator » |
| État incohérent après des essais | `npm run dev -- --fresh` |
| Ports occupés après un crash | fermer les anciens terminaux, ou `npx kill-port 4000 4100 4200 4300 4400 4500 5173 5174 8545` |

## 7. À faire avant de rendre le projet

- Compléter [AI_TOOLS.md](AI_TOOLS.md) avec votre propre usage.
- Optionnel : déployer sur Base Sepolia (`.env.example`, puis `npm run setup:base-sepolia`) et mettre les liens
  basescan dans le README.
- Enregistrer une vidéo de secours de la démo (`npm run test:ui` génère aussi des captures).
