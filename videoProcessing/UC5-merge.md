# UC5 — Registo de alterações e guia de merge com o `main`

**Data:** 2026-10-23
**Ramo do UC5:** `uc-5` (local). Último commit: `d532a2e`; o resto está por commitar.
**Ponto de partida comum com o `main`:** `150668a` (merge do PR #4).
**O que entrou entretanto no `main`:** `c7da3f0` e `b45a3c1`, o UC3 (áudio), que **reorganizou o serviço de vídeo e o gateway**.

Este documento serve para fazer o merge sem estragar o trabalho dos colegas. Explica:

1. tudo o que foi feito para o UC5, passo a passo;
2. o que o UC3 mudou nos mesmos ficheiros;
3. para cada ficheiro, o que manter, o que deitar fora e o que adaptar;
4. os comandos do merge e como verificar que nada se partiu.

O relatório funcional do UC5 (decisões, testes e rastreabilidade) está em [`UC5-concatenacao.md`](UC5-concatenacao.md).

---

## 1. O que foi feito, passo a passo

### Passo 0 — Scroll na página de vídeo (já está no `main`)
- `frontend/components/project-page/video-project-view.tsx`: o contentor do editor passou de `min-h-full` para `h-full overflow-y-auto`, para se poder fazer scroll com vídeos verticais.
- `frontend/components/video/video-trim-editor.tsx`: o vídeo ficou com `max-h-[60vh] object-contain`.

Estas duas linhas já estão no `main`, por isso não há nada a fazer.

### Passo 1 — Núcleo da concatenação
- **Novo** `videoProcessing/concat.py`:
  - `probe_input` lê os metadados com `ffprobe`;
  - `validate_count` e `validate_limits` aplicam a RN1, a RN3 e a RN2 comum;
  - `check_compatibility` aplica a RN7;
  - `write_list_file` escreve a lista do concat demuxer;
  - `build_concat_command` monta o `ffmpeg -f concat -c copy`;
  - `verify_result` aplica a RN4 (duração igual à soma).
- **Novo** `videoProcessing/tests/test_concat.py`.

### Passo 2 — Serviço, rotas internas, quota e biblioteca (commit `d532a2e`)
- `concat.py`:
  - `ConcatService` herda do `TrimService` (fila, recuperação, cancelamento, timeout e compensações) e só reescreve `submit` e `_run`;
  - Blueprint `/video/concat` com `POST ""`, `GET /tasks`, `GET /tasks/<id>`, `DELETE /tasks/<id>` e `GET /tasks/<id>/download`.
- `trim.py`: atributo `namespace = "trim"`, para cada operação ter a sua pasta de tarefas.
- `trim_integration.py`: os hooks reais e a validação do JWT passaram para `_integration(audience, kind)`. Novo `register_concat()`. Ao publicar, envia `kind`.
- `projects/routes/videoResults.js`: ao publicar, aceita `kind` (`trim` ou `concat`) e copia o resultado da pasta certa.
- `server.py`: regista o concat. `Dockerfile`: copia `concat.py`.

### Passo 2b — FPS variável aceite no UC5
- `concat.py`: tirada a recusa `VARIABLE_FPS`. A RN7 passa a comparar o FPS nominal (`r_frame_rate`). Decisão D4 do relatório.
- `test_concat.py`: teste com vídeos de FPS variável.

### Passo 3 — Gateway
- **Novo** `apiGateway/routes/videoConcat.js`:
  - `POST /:user/:project/video/concat` com `{ videos: [projectId, ...] }`;
  - rotas de tarefas e de download;
  - para cada vídeo, vai buscar o original ao `projects` (o que verifica o dono) e assina um JWT `video-concat`.
- `apiGateway/routes/videoTrim.js`: `context(req, audience)`; os helpers são exportados em `shared`.
- `apiGateway/routes/projects.js`: `router.use(require("./videoConcat"))`.
- `projects/routes/videoResults.js`: nova rota interna `GET /:user/library`, que lista os projetos de vídeo do utilizador. Tem de ficar **antes** do middleware `/:user/:project`.
- **Novo** `videoProcessing/tests/manual_concat.py`: teste manual sem gateway.

### Passo 4 — Frontend
- `frontend/lib/video.ts`: tipos `VideoLibraryItem` e `VideoConcatTask`, e as funções `listVideoLibrary`, `createVideoConcatTask`, `getVideoConcatTask`, `listVideoConcatTasks` e `cancelVideoConcatTask`. O `VideoResult` ganhou `size?` e `inputs?`.
- **Novo** `frontend/components/video/video-concat-editor.tsx`: o ecrã do UC5.
- `frontend/components/video/video-editor.tsx`: a operação `"concat"`, o botão "Concatenar com outros vídeos" e o `return` antecipado para o `VideoConcatEditor`.

### Passo 5 — Metadados da biblioteca (CON-007)
- `concat.py`:
  - `inspect_source` lê os metadados de um URL HTTP(S) com Range;
  - `_describe` é a parte comum ao ficheiro e ao URL;
  - `compatibility_signature` dá a lista da RN7, usada também pela validação;
  - `describe` monta os metadados para a interface;
  - a Blueprint ganhou `GET /library`, se houver um `library_provider`.
- `trim_integration.py`: `register_concat` define o `library(ctx)`, que lista a biblioteca no `projects` e lê os metadados de cada vídeo. `_integration` devolve também o `call`.
- `videoConcat.js`: a rota pública passou a ser `GET /:user/:project/video/concat/library` e chama o serviço de vídeo.
- `lib/video.ts` e `video-concat-editor.tsx`: mostram os metadados e o aviso de incompatibilidade.

---

## 2. O que o UC3 mudou no `main`

O colega do UC3 fez uma reorganização muito parecida com a do UC5, mas mais completa.

| Antes (o que o UC5 usa) | Agora no `main` |
|---|---|
| `videoProcessing/trim.py` com `TrimService`, `TrimError`, `TrimContext`, `TrimHooks`, `_Job`, `_now` | **Apagado.** Dividido em `utils/common.py` (`VideoError`, `VideoContext`, `VideoHooks`, `VideoJob`, `utc_now`, `profile_limits`), `utils/tasks.py` (`VideoTaskService`, com `namespace`), `utils/media.py` (`probe_json`, `probe_video`) e `use_cases/trim.py` |
| `videoProcessing/trim_integration.py` | Passou a `utils/integration.py` com `register_video_service(app, task_root, ServiceType, blueprint_factory, operation)`. A audiência do JWT é `video-<operation>`. Ao publicar, envia `processor: <operation>`. Cada operação tem um ficheiro `use_cases/<op>_integration.py` |
| `server.py` importa `trim_integration` | Importa `use_cases.trim_integration` e `use_cases.audio_integration` |
| `Dockerfile` copia ficheiros soltos | Copia `server.py`, `use_cases/` e `utils/` |
| Helpers do gateway dentro do `videoTrim.js` | Passaram para `apiGateway/routes/videoAccess.js`, e o `context(req, audience)` já recebe a audiência |
| `projects` sem campo de operação ao publicar | Aceita `processor` (`trim` ou `audio`) e lê de `/video-tasks/tasks/<processor>` |
| `video-editor.tsx` com o ecrã de recorte desligado | O `VideoTrimEditor` voltou a estar ligado, e foram acrescentados o `VideoAudioEditor` e o botão "Gerir áudio". O `return` principal passou a `const legacyEditor = (...)` |
| `lib/video.ts` | Funções do UC3 acrescentadas no fim do ficheiro |

**Conclusão:** a infraestrutura que o UC5 criou (`namespace`, audiência por operação, campo que diz ao `projects` de que pasta copiar) **já existe no `main` com outros nomes**. No merge, deita-se fora a versão do UC5 e adapta-se o UC5 à do `main`.

---

## 3. Ficheiro a ficheiro: o que fazer no merge

| Ficheiro | Ação | Detalhe |
|---|---|---|
| `videoProcessing/trim.py` | **Deitar fora a alteração do UC5** | O ficheiro foi apagado no `main`. A ideia do `namespace` já existe em `VideoTaskService`. |
| `videoProcessing/trim_integration.py` | **Deitar fora a alteração do UC5** | Foi substituído por `utils/integration.py`. |
| `videoProcessing/concat.py` | **Mover e adaptar** para `videoProcessing/use_cases/concat.py` | Ver 3.1. |
| (novo) `videoProcessing/use_cases/concat_integration.py` | **Criar** | Ver 3.2. |
| `videoProcessing/server.py` | **Ficar com a versão do `main`** e acrescentar o concat | `from use_cases.concat_integration import register_concat` e `register_concat(app, TASK_ROOT)`. |
| `videoProcessing/Dockerfile` | **Ficar com a versão do `main`** | Já copia `use_cases/`; não é preciso acrescentar nada. |
| `videoProcessing/tests/test_concat.py` | **Adaptar os imports** | Ver 3.3. |
| `videoProcessing/tests/manual_concat.py` | Manter | Não depende de outros módulos. |
| `projects/routes/videoResults.js` | **Juntar as duas versões** | Ver 3.4. |
| `apiGateway/routes/videoTrim.js` | **Ficar com a versão do `main`** | Os helpers estão agora no `videoAccess.js`. |
| `apiGateway/routes/videoConcat.js` | **Adaptar 1 linha** | Importar de `./videoAccess` em vez de `require("./videoTrim").shared`. |
| `apiGateway/routes/projects.js` | **Juntar** | Ficam as três linhas: `videoTrim`, `videoAudio` e `videoConcat`. |
| `frontend/lib/video.ts` | **Juntar** | Ficam as funções do UC3 e as do UC5, umas a seguir às outras. O `VideoResult` fica com `size?` e `inputs?`. |
| `frontend/components/video/video-editor.tsx` | **Ficar com a versão do `main`** e voltar a pôr o concat | Ver 3.5. |
| `frontend/components/video/video-concat-editor.tsx` | Manter | Não depende de ficheiros alterados pelo UC3. |
| `videoProcessing/UC5-*.md` | Manter | São documentação. |

### 3.1 `use_cases/concat.py`
- **Imports:**
  - `from utils.common import VideoError, VideoJob, profile_limits, utc_now`
  - `from utils.tasks import VideoTaskService`
  - `from utils.media import probe_json`
- **Substituições:**
  - `ConcatError(TrimError)` passa a `ConcatError(VideoError)`;
  - `ConcatService(TrimService)` passa a `ConcatService(VideoTaskService)`, mantendo `namespace = "concat"`;
  - `_Job` passa a `VideoJob` e `_now()` passa a `utc_now()`;
  - nos errorhandlers da Blueprint, `TrimError` passa a `VideoError`.
- **`_ffprobe`:** passa a usar `probe_json(path, [*input_options, "-show_format", "-show_streams"], timeout)`. Os códigos de erro são os mesmos.
- **Limites por vídeo:** `LIMITS` passa a vir de `profile_limits(profile)`, para usar os mesmos valores do compose que o resize, o trim e o áudio. No `main` são MiB: 200 MiB e 2 GiB. As mensagens passam a dizer "MiB", como no resto do `main`.
- **O resto fica igual:** `submit`, `_run`, `compatibility_signature`, `describe`, `inspect_source`. O `_run` do concat continua a substituir o do `VideoTaskService`, porque o deste só sabe tratar uma entrada.

### 3.2 `use_cases/concat_integration.py`
O `register_video_service` do `main` recebe uma `blueprint_factory(service, context)`. Para passar o `library_provider`, usa-se uma closure:

```python
def register_concat(app, task_root):
    def library(ctx): ...   # lista /:user/library no projects + inspect_source de cada /source
    return register_video_service(
        app, task_root, ConcatService,
        lambda service, context: create_concat_blueprint(service, context, library),
        "concat")
```

Com `operation="concat"`, a audiência do JWT passa a ser `video-concat` (igual à que o gateway do UC5 já assina) e a publicação envia `processor: "concat"`. O `library` precisa de um pedido `GET` ao `projects` com o segredo interno, feito com `urllib`, como no `utils/integration.py`.

### 3.3 `tests/test_concat.py`
- `from trim import TrimContext, TrimError, TrimHooks` passa a `from utils.common import VideoContext, VideoError, VideoHooks`.
- `from concat import ...` passa a `from use_cases.concat import ...`.
- Em `IntegrationTests`, `register_concat` vem de `use_cases.concat_integration`. O patch passa de `trim_integration.urlopen` para `utils.integration.urlopen`. O teste do `kind` passa a verificar `processor == "concat"`.
- O teste de tamanho usa os limites de `profile_limits`.

### 3.4 `projects/routes/videoResults.js`
Fica com o `processor` do `main` e acrescenta o `concat`:
- a lista branca passa a `["trim", "audio", "concat"]`;
- a pasta de origem passa a `path.join(path.dirname(VIDEO_RESULTS_ROOT || "/video-tasks/tasks/trim"), processor)` para qualquer operação que não seja o trim;
- deita-se fora o `kind` e o `resultRoots` do UC5;
- **mantém-se** a rota `GET /:user/library` do UC5, antes do middleware `/:user/:project`.

### 3.5 `frontend/components/video/video-editor.tsx`
Na versão do `main`:
- `type VideoOperation = "resize" | "trim" | "audio" | "concat";`
- `import { VideoConcatEditor } from "./video-concat-editor";` e o ícone `Layers`;
- ao lado do botão "Gerir áudio": `<Button variant="outline" onClick={() => setOperation("concat")}>Concatenar vídeos</Button>`;
- antes de `if (operation === "audio") ...`: `if (operation === "concat") return <VideoConcatEditor ... onBack={() => setOperation("resize")} />;`

---

## 4. Como fazer o merge

```bash
# 1. Guardar o trabalho do UC5 num commit no ramo uc-5 (ponto de regresso seguro)
git add -A
git commit -m "UC5: gateway, frontend e metadados da biblioteca"

# 2. Trazer o main para o ramo uc-5 (não mexe no main)
git fetch origin
git merge origin/main
#    → vai dar conflitos nos ficheiros da tabela da secção 3; resolver como lá diz

# 3. Verificar antes de concluir o merge
docker compose build video_processing
docker run --rm -v "$PWD/videoProcessing:/app" -w /app picturas-video_processing \
  python -m unittest discover -s tests -p "test_*.py"
cd frontend && npx tsc --noEmit -p . && cd ..

# 4. Concluir o merge e reconstruir
git add -A && git commit
docker compose up -d --build video_processing projects api_gateway frontend
docker compose restart nginx
```

Se algo correr mal antes do passo 4: `git merge --abort` volta ao estado do passo 1, sem perder nada.

### 4.1 Verificação depois do merge (não partir o trabalho dos colegas)

| O quê | Como | Esperado |
|---|---|---|
| Testes do UC2 e do UC3 | `test_trim.py`, `test_trim_integration.py`, `test_audio.py` | Todos passam, sem alterações nos testes deles |
| Testes do UC5 | `test_concat.py` | Todos passam |
| UC2 no browser | Recortar um vídeo | Funciona como antes, e o resultado aparece nos resultados |
| UC3 no browser | Gerir áudio | Funciona como antes |
| UC5 no browser | Concatenar os dois clips de teste | Resultado de 7 s; os metadados aparecem na biblioteca |
| Resultados antigos | Abrir os resultados de um projeto | Os cortes e os resultados de áudio continuam lá |

---

## 5. O que avisar os colegas

- O UC5 acrescenta `"concat"` à lista de `processor` no `projects/routes/videoResults.js` e generaliza a pasta de origem para `.../tasks/<processor>`. O comportamento do trim e do áudio é o mesmo.
- O UC5 acrescenta a rota interna `GET /internal/video/:user/library` ao `projects`.
- O UC5 acrescenta uma operação ao `video-editor.tsx` e funções ao fim do `lib/video.ts`. Não altera as do UC2 nem as do UC3.
- Depois do merge, os ficheiros `videoProcessing/trim.py` e `trim_integration.py` **não voltam** a existir (o merge mantém a remoção feita no `main`).
