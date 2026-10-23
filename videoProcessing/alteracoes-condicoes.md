# Alterações às condições dos casos de uso de vídeo

Branch: `ConditionChangesUCs` (criada a partir do `main` em `4f9e154`).

Este documento descreve as alterações a quatro condições que recusavam vídeos reais sem necessidade técnica. Para cada uma indica a regra antiga, a razão da mudança, o que mudou no código e no documento de requisitos, e como foi testada.

| # | Condição | Casos de uso afetados | Requisito |
|---|----------|-----------------------|-----------|
| 1 | Recusar vídeos com FPS variável | UC1 | REQ-VID-COM-005 |
| 2 | Aceitar só H.264 ou VP9 como entrada | UC1 | REQ-VID-COM-006 |
| 3 | Recusar vídeos com mais de uma faixa de áudio | UC1, UC3, UC5 | REQ-VID-COM-005 |
| 6 | Concatenar só sem recodificar | UC5 | REQ-VID-CON-012, RN7 do UC5 |

Os pontos 4 (faixas de dados), 5 (ajuste do fim do corte rápido) e as legendas **não foram alterados**. Ver [O que ficou por fazer](#o-que-ficou-por-fazer).

---

## 1. FPS variável passa a ser aceite (UC1)

**Regra antiga.** O UC1 recusava um vídeo quando o FPS declarado (`r_frame_rate`) e o FPS médio (`avg_frame_rate`) diferiam mais de 0,01 (erro `VARIABLE_FRAME_RATE`).

**Porque mudou.**
- Os telemóveis gravam quase sempre com FPS variável (o FPS baixa com pouca luz e em imagem parada). Com esta regra, todos os vídeos de telemóvel testados eram recusados no redimensionamento.
- Nenhuma operação precisa de FPS constante. O UC2 e o UC3 nunca verificaram esta condição, e o UC5 já a tinha retirado.
- O redimensionamento recodifica a imagem, e o FFmpeg pode manter o instante de cada fotograma tal como está.

**O que mudou** (`videoProcessing/server.py`)
- Em `inspect_video`, foi removida a verificação de FPS variável. Continua a verificação de que o FPS é válido e maior que zero.
- Em `run_task`, o comando do FFmpeg ganhou `-fps_mode passthrough`. Assim, cada fotograma mantém o instante original, sem fotogramas duplicados nem eliminados.

**Requisito.** Retirar "FPS variável" da lista de recusas do REQ-VID-COM-005.

---

## 2. Qualquer codec de entrada que o FFmpeg leia passa a ser aceite (UC1)

**Regra antiga.** O UC1 só aceitava MP4 com H.264 e AAC, ou WebM com VP9 e Opus (erros `UNSUPPORTED_VIDEO_CODEC` e `UNSUPPORTED_AUDIO_CODEC`).

**Porque mudou.**
- O redimensionamento recodifica sempre para H.264/AAC (MP4) ou VP9/Opus (WebM). Por isso, o codec de entrada só tem de ser legível; não tem de ser igual ao de saída.
- A regra recusava as gravações de ecrã do iPhone (HEVC), que o UC2, o UC3 e o UC5 já aceitavam.
- A restrição de codecs continua a fazer sentido para a **saída** (RN3 do UC1), e essa não foi alterada.

**O que mudou** (`videoProcessing/server.py`)
- Foi removida a tabela `SUPPORTED_CONTAINERS` e a verificação de codecs de entrada.
- Passa a recusar apenas vídeos cujo codec o FFmpeg não reconhece (`codec_name` igual a `unknown` ou `none`). Nesse caso devolve o erro `UNREADABLE_VIDEO`.
- A verificação de contentor (MP4/MOV ou WebM) mantém-se, porque é o que a plataforma aceita no carregamento.

**Requisito.** O REQ-VID-COM-006 passa a dizer: *"O sistema deve aceitar vídeos MP4, MOV ou WebM cujo conteúdo o FFmpeg consiga ler. Os resultados são produzidos em MP4 (H.264 com AAC) ou WebM (VP9 com Opus)."*

---

## 3. Usar a primeira faixa de áudio legível e ignorar as outras, com aviso (UC1, UC3, UC5)

**Regra antiga.** O UC1, o UC3 e o UC5 recusavam vídeos com mais de uma faixa de áudio (erros `MULTIPLE_AUDIO_STREAMS`, `MULTIPLE_AUDIO_TRACKS` e `UNSUPPORTED_STREAMS`).

**Porque mudou.**
- Os iPhones recentes gravam duas faixas de áudio: uma AAC normal e uma de áudio espacial (APAC). O FFmpeg não consegue ler a faixa APAC; o `ffprobe` mostra-a como `codec_name=unknown`.
- Por isso, qualquer vídeo de iPhone recente era recusado, apesar de ter uma faixa AAC perfeitamente utilizável.
- O UC2 nunca teve esta regra.

**O que mudou**

- `videoProcessing/utils/media.py` (novo código partilhado):
  - `select_audio(streams)`: devolve a primeira faixa de áudio com codec conhecido e o número de faixas ignoradas.
  - `audio_notice(...)`: devolve a mensagem de aviso, por exemplo *"O vídeo tem 2 faixas de áudio. É usada só a primeira legível (aac); as outras são ignoradas."*. Se nenhuma faixa for legível, o resultado fica sem áudio e o aviso diz isso.

- **UC1** (`server.py`):
  - `inspect_video` usa `select_audio` e guarda o índice da faixa escolhida (`audioStreamIndex`) e os avisos (`warnings`).
  - O comando do FFmpeg passou a ter `-map 0:v:0 -map 0:<faixa escolhida>`. Sem este mapeamento, o FFmpeg escolhe a faixa com mais canais, que no iPhone é precisamente a APAC ilegível.
  - Tarefas criadas antes desta alteração usam `0:a:0?`.

- **UC3** (`use_cases/audio.py`):
  - `_stage` usa `select_audio`, e o vídeo só é considerado "com áudio" se tiver uma faixa legível.
  - O índice da faixa vai para a tarefa (`audioStreamIndex`), e `build_audio_command` usa-o em vez de `0:a:0`, incluindo na mistura (`mix`).
  - O aviso é devolvido em `video.audioNotice`.

- **UC5** (`use_cases/concat.py`):
  - `_describe` usa `select_audio`.
  - Na cópia direta, o FFmpeg mapeia só a faixa escolhida (antes era `0:a?`, todas as faixas).
  - O aviso aparece em cada vídeo da biblioteca (`audioNotice`) e na tarefa (`warnings`).

- **Frontend.** O aviso é mostrado (a amarelo, sem bloquear a operação):
  - no redimensionamento (`video-editor.tsx`);
  - na gestão de áudio (`video-audio-editor.tsx`);
  - na biblioteca e na tarefa da concatenação (`video-concat-editor.tsx`).

**Requisito.** O REQ-VID-COM-005 passa a dizer: *"Se o vídeo tiver várias faixas de áudio, é usada a primeira que o sistema consegue ler e as restantes são ignoradas, sendo o utilizador avisado."*

---

## 6. Concatenar com cópia quando possível e converter, com confirmação, quando não é (UC5)

**Regra antiga.** O UC5 só concatenava por cópia de streams (concat demuxer, `-c copy`), por isso todos os vídeos tinham de ser iguais em contentor, codec, resolução, FPS, áudio, etc. (RN7). Caso contrário, devolvia `INCOMPATIBLE_VIDEOS`.

**Porque mudou.** Vídeos de origens diferentes (telemóvel, gravação de ecrã, resultados de outras operações) quase nunca são compatíveis. Com a biblioteca de teste, praticamente nenhum par de vídeos podia ser concatenado.

**Como funciona agora**

1. Se os vídeos são compatíveis (RN7), a concatenação usa a cópia direta, como antes: é rápida e não perde qualidade.
2. Se não são, o pedido devolve **409 `CONVERSION_REQUIRED`**, sem criar tarefa nem reservar quota. A resposta indica qual o vídeo e o campo que diferem (`index`, `field`, `detail`) e o formato final (`target`).
3. A interface mostra uma caixa de confirmação com o formato final e o aviso de que a conversão demora mais e recodifica a imagem. Ao carregar em **"Converter e concatenar"**, o pedido é repetido com `convert: true`.
4. Na conversão (`build_convert_command`), todos os vídeos são recodificados para o formato do **primeiro vídeo da sequência**:
   - **Resolução:** a do primeiro vídeo, com a rotação aplicada e arredondada a números pares. Os vídeos com outra proporção ficam com margens pretas e nunca são deformados.
   - **FPS:** o FPS médio do primeiro vídeo, até 60.
   - **Imagem:** 8 bits, 4:2:0.
   - **Áudio:** 48 kHz estéreo. Um vídeo sem áudio recebe silêncio com a duração da imagem, para o som não ficar desalinhado nos vídeos seguintes.
   - **Codecs:** H.264 com AAC em MP4/MOV, ou VP9 com Opus se o primeiro vídeo for WebM.
5. O resultado continua a ser verificado (RN4): a duração tem de ser igual à soma das durações (com tolerância de 0,1 s por vídeo), a resolução tem de ser a do formato final, e o áudio tem de estar presente se alguma entrada tiver áudio.

**Outras alterações na comparação RN7.** Foram acrescentados dois campos:
- **rotação:** dois vídeos com o mesmo tamanho mas rotações diferentes não podem ser copiados juntos;
- **faixas do ficheiro:** o concat demuxer associa as faixas pela posição, por isso a ordem e o tipo das faixas têm de coincidir.

Antes, nestes dois casos, a cópia podia falhar ou dar um resultado errado. Agora estes vídeos passam pela conversão.

**Ficheiros alterados**
- `videoProcessing/use_cases/concat.py`:
  - `find_mismatch` (substitui `check_compatibility`);
  - `conversion_target` e `build_convert_command`;
  - `prepare_inputs(..., convert)` devolve `(entradas, alvo)`;
  - a tarefa ganhou `mode` (`copy` ou `convert`), `target` e `warnings`;
  - a rota recebe `convert=true`.
- `apiGateway/routes/videoConcat.js`: passa `convert` ao serviço.
- `frontend/lib/video.ts`: tipo `ConcatTarget` e parâmetro `convert` em `createVideoConcatTask`.
- `frontend/components/video/video-concat-editor.tsx`:
  - a incompatibilidade deixou de bloquear o botão e passou a ser um aviso;
  - caixa de confirmação da conversão;
  - indicação "convertido" na tarefa.

**Requisitos**
- O REQ-VID-CON-012 passa a dizer: *"Quando os vídeos são compatíveis, a concatenação é feita sem recodificação. Quando não são, o sistema informa o utilizador e, após confirmação, converte-os para a resolução, o FPS e o formato do primeiro vídeo."*
- A RN7 do UC5 deixa de ser uma condição para concatenar e passa a decidir se a concatenação é feita por cópia ou por conversão.

---

## Testes

**Testes automáticos.** Os 71 testes passam (`test_trim`, `test_trim_integration`, `test_audio`, `test_concat`), corridos no contentor `video_processing`. Testes alterados ou novos:

- `test_concat.py`:
  - a incompatibilidade agora pede conversão (`CONVERSION_REQUIRED`, 409) e indica o formato final;
  - `prepare_inputs` com `convert=True` devolve o formato final, mas vídeos compatíveis continuam a ser copiados;
  - conversão real de 4 vídeos com resolução, FPS e presença de áudio diferentes;
  - um vídeo com 2 faixas de áudio usa a primeira, o resultado tem uma só faixa de áudio, e há aviso;
  - `select_audio` ignora faixas com codec `unknown`.
- `test_audio.py`: num vídeo com 2 faixas (silêncio e um tom), é usada só a primeira, e o tom da segunda não aparece no resultado.

**Testes com vídeos reais, através do gateway:**

| Vídeo | Antes | Agora |
|-------|-------|-------|
| Gravação de ecrã iPhone (HEVC, FPS variável) | UC1 recusava | UC1 redimensiona para 640×360 |
| Vídeo com FPS variável (84c3ab7e) | UC1 recusava | UC1 aceita |
| IMG_8870.mov (iPhone: AAC + APAC + 6 faixas de dados) | UC3 e UC5 recusavam | UC3 e UC5 aceitam, com aviso; o UC1 continua a recusar (ponto 4) |
| IMG_8870.mov + gravação de ecrã (concatenação) | `INCOMPATIBLE_VIDEOS` | 1.º pedido: `CONVERSION_REQUIRED`. Depois de confirmar: 61 s em 1080×1920, publicado |
| iPhone + gravação de ecrã + FPS variável (conversão) | — | cerca de 101 s de vídeo convertidos em cerca de 12 s |

---

## O que ficou por fazer

- **Ponto 4: faixas de dados (UC1).** O UC1 continua a recusar vídeos com faixas de dados (`UNSUPPORTED_STREAM`), e é por isso que os vídeos de iPhone (`IMG_8870.mov`) ainda não podem ser redimensionados. O UC2, o UC3 e o UC5 já as ignoram. Para mudar, basta retirar essa verificação em `inspect_video`; o comando do FFmpeg já usa `-map` explícito, por isso as faixas de dados ficariam de fora do resultado.
- **Ponto 5: ajuste do fim no corte rápido (UC2).** Não foi alterado.
- **Legendas (UC1).** Continuam a ser recusadas.

## Limitações conhecidas

- **Vídeos HDR.** A conversão do UC5 produz vídeo de 8 bits sem conversão de HDR para SDR. Um vídeo HDR (por exemplo, HEVC 10 bits do iPhone) pode ficar com as cores menos vivas no resultado convertido.
- **Formato do primeiro vídeo.** O formato do resultado convertido é sempre o do primeiro vídeo. Para mudar o formato do resultado, basta mudar a ordem na sequência.
- **Tempo limite.** A conversão está sujeita ao mesmo limite de 30 minutos por tarefa que as outras operações.
