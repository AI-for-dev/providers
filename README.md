# @ai-for-dev/providers

Providers [Pi](https://pi.dev) pour la formation AI4Dev. Le paquet ajoute deux fournisseurs de modèles :

| Commande | Serveur |
|---|---|
| `/login ia4dev-ilaas` | https://devllm.ilaas.fr/v1 |
| `/login ia4dev-gricad` | https://ia4dev-owui.univ-grenoble-alpes.fr/api |

## Installation

```bash
pi install npm:@ai-for-dev/providers
```

## Utilisation

1. Lancez `pi`.
2. Tapez `/login ia4dev-ilaas` (ou `/login ia4dev-gricad`) et collez votre clé API.
3. Choisissez un modèle avec `/model`.

La liste des modèles est lue sur le serveur (`GET /models`) avec votre clé. Elle se met à jour au démarrage, à l'ouverture de `/model` et après `/login`.

Vous pouvez aussi fournir la clé par variable d'environnement : `ILAAS_API_KEY` ou `IA4DEV_API_KEY`.

## Changer d'URL

`IA4DEV_ILAAS_BASE_URL` et `IA4DEV_GRICAD_BASE_URL` remplacent l'URL par défaut.

## Réglages des modèles

`extensions/index.ts` contient, pour chaque serveur, une table des modèles connus : taille du contexte, sortie maximale, lecture d'images et gestion du raisonnement. Ces valeurs ont été mesurées sur les serveurs. Le raisonnement peut être :

- activable (`toggle`) : Pi propose `off` et `high`, et passe par `chat_template_kwargs.enable_thinking` ;
- permanent (`always`) : Pi ne propose que `high` ;
- absent (`none`) : Pi n'envoie aucun paramètre de raisonnement.

Un modèle marqué `hidden: true` n'apparaît pas, même si le serveur le liste. Un modèle qui n'est pas dans la table reste utilisable. Il prend la taille de contexte donnée par le serveur (128 000 tokens à défaut), 32 768 tokens de sortie, sans images ni raisonnement.

## Limites

- Un fournisseur déjà défini sous le même nom dans `~/.pi/agent/models.json` prend le dessus sur celui du paquet.
- La liste des modèles est mise en cache. Après un changement d'URL, elle se met à jour au prochain rafraîchissement (`/model` ou `/login`).

## Développement

```bash
npm ci
npm run typecheck
npm test
```

Les tests tournent hors ligne : un faux `pi` et un `fetch` simulé remplacent Pi et les serveurs.

## Publication

La publication reprend le fonctionnement de `@ai-for-dev/combo` :

1. Lancer le workflow `release-please` à la main. Il ouvre une pull request avec le `CHANGELOG.md` et la nouvelle version, calculés à partir des titres de commits (conventional commits).
2. Fusionner cette pull request, puis relancer `release-please`. Ce second passage crée le tag et la release GitHub.
3. La release déclenche `publish`, qui vérifie le code et envoie le paquet sur npm en mode « staged ».
4. Approuver la version depuis une machine qui peut répondre à la double authentification : `npm stage list`, puis `npm stage approve <id>`.

Le dépôt a besoin du secret `RELEASE_PLEASE` (un token GitHub qui peut écrire le contenu et les pull requests), et npm doit déclarer ce dépôt et `publish.yml` comme éditeur de confiance (trusted publisher) pour `@ai-for-dev/providers`.
