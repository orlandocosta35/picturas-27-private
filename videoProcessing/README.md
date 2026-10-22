# Processamento de vídeo

O `server.py` mantém as rotas de redimensionamento (UC1) e regista os módulos de corte (UC2) e gestão de áudio (UC3). O `use_cases/trim.py` contém a lógica de corte e o `use_cases/audio.py` contém a lógica de áudio. Ambos usam o pacote `utils`: `common.py` reúne tipos e limites, `media.py` analisa os ficheiros, `tasks.py` gere o ciclo das tarefas e `integration.py` autentica os pedidos internos e liga quota e resultados aos serviços `users` e `projects`. Os ficheiros `use_cases/trim_integration.py` e `use_cases/audio_integration.py` registam cada operação.

## Arranque

Os quatro serviços `api_gateway`, `video_processing`, `users` e `projects` precisam do mesmo `VIDEO_INTERNAL_SECRET`. O Compose lê esta chave do `.env` na raiz, que não deve ser versionado. Para a configurar pela primeira vez, acrescenta uma chave aleatória ao `.env`:

```sh
python3 -c 'import secrets; print("VIDEO_INTERNAL_SECRET=" + secrets.token_urlsafe(48))' >> .env
```

Não é necessário regenerá-la em cada arranque. Não partilhar nem publicar o `.env`.

Na raiz do projeto:

```sh
docker compose up -d --build users projects api_gateway video_processing frontend nginx
```

O Compose arranca também as dependências declaradas destes serviços.

## Fluxo do corte

1. O frontend envia o intervalo e o modo ao gateway.
2. O gateway valida o utilizador, consulta o perfil atual e obtém o original guardado no projeto. O cliente não substitui o ficheiro neste pedido.
3. O trim verifica o conteúdo, o tamanho, a duração e o intervalo. O modo Rápido pede confirmação quando os limites mudam; o intervalo completo não cria tarefa nem consome quota.
4. Uma reserva identificada pelo ID da tarefa impede consumo duplicado. A contagem é partilhada com as operações existentes de imagens e resize. A reserva do trim é atómica com a verificação do limite.
5. FFmpeg executa o corte. O progresso permanece abaixo de 100% até o resultado e a quota estarem confirmados.
6. `projects` copia o resultado para a biblioteca local do projeto. O original e o campo `video` são preservados; os cortes são registados em `videoResults`.
7. O frontend consulta o estado, apresenta o resultado guardado e permite descarregá-lo. Pode sair e voltar à página: a tarefa continua no backend.

O perfil Gratuito tem no máximo uma tarefa de trim ou áudio ativa. O Premium pode aceitar várias, executadas pelas filas locais dos módulos. A concorrência das rotas de resize existentes não foi reorganizada nesta alteração.

A quota diária usa `Europe/Lisbon`. Uma tarefa é cobrada ao dia em que foi aceite, mesmo que termine depois da meia-noite. O cancelamento ou a falha liberta a reserva. As compensações são idempotentes; se um serviço estiver indisponível, ficam registadas e são repetidas a cada 30 segundos e no arranque.

A estimativa de tempo na interface usa o histórico de cortes concluídos no mesmo modo. Sem histórico, a interface informa que ainda não pode estimar. O tempo real depende do vídeo e da carga da máquina.

## Rotas públicas do gateway

Prefixo: `/projects/:user/:project/video` (autenticação JWT obrigatória).

| Método | Rota | Finalidade |
|---|---|---|
| POST | `/trim` | Pedir corte ou confirmar o intervalo efetivo. |
| GET | `/trim/tasks` | Recuperar tarefas do utilizador neste projeto. |
| GET | `/trim/tasks/:id` | Consultar estado e progresso. |
| DELETE | `/trim/tasks/:id` | Cancelar uma tarefa ativa. |
| GET | `/trim/tasks/:id/download` | Descarregar resultado da tarefa concluída. |
| GET | `/results` | Listar cortes publicados no projeto. |
| GET | `/results/:id/download` | Descarregar um corte guardado na biblioteca. |

O POST recebe JSON com `startSeconds`, `endSeconds` e `mode` (`fast` ou `precise`). A confirmação é um novo pedido com os tempos efetivos apresentados pelo servidor; o intervalo é novamente validado.

## Persistência e limites de execução

- `video_data`: tarefas e resultados de processamento. O `projects` monta este volume apenas para leitura em `/video-tasks`.
- `image_data`: contém os originais e as cópias publicadas dos resultados no serviço `projects`.
- MongoDB de `users`: reservas por tarefa e contador partilhado de operações.
- MongoDB de `projects`: metadados dos cortes publicados.
- O módulo suporta um processo executor por diretório de tarefas. O Gunicorn está configurado com um worker; não aumentar os workers nem replicar este serviço sem introduzir coordenação entre executores.
- Tarefas interrompidas num reinício ficam como falhadas e são compensadas. Não são reexecutadas automaticamente.
- O timeout de processamento é de 30 minutos, excluindo a espera na fila. As chamadas internas têm timeouts próprios.
- O backup MongoDB não inclui automaticamente os volumes de ficheiros.

## Testes

O ambiente de integração executa os testes do módulo com FFmpeg real e os testes entre serviços numa base de dados temporária. As instruções estão em [tests/integration/README.md](tests/integration/README.md).

## Limites partilhados de entrada

Resize e trim leem as mesmas variáveis do Compose: `VIDEO_MAX_SIZE_FREE`, `VIDEO_MAX_SIZE_PREMIUM`, `VIDEO_MAX_DURATION_FREE` e `VIDEO_MAX_DURATION_PREMIUM`. Os tamanhos são configurados em bytes e as durações em segundos. Os valores por omissão são 209 715 200 bytes (200 MiB) / 300 segundos para Gratuito e 2 147 483 648 bytes (2 GiB) / 1800 segundos para Premium. O limite HTTP do trim usa o mesmo tamanho, com uma margem adicional apenas para os campos multipart; o ficheiro continua sujeito ao limite exato.

## UC3 — Gerir áudio de um vídeo

O módulo `use_cases/audio.py` implementa uma operação por pedido: ajustar volume, remover áudio ou sobrepor um ficheiro auxiliar (misturar/substituir). A integração está em `use_cases/audio_integration.py`. Usa o ciclo de tarefas partilhado em `utils/tasks.py`, com diretório próprio `tasks/audio`, autenticação com audience `video-audio` e a mesma quota identificada por tarefa. Uma tarefa ativa de áudio também ocupa a reserva que impede outro trim/áudio simultâneo no perfil Gratuito.

O gateway obtém o vídeo original ou um resultado publicado do mesmo projeto. Um `sourceResultId` opcional seleciona esse resultado, sem substituir nem modificar o original. O painel permite selecionar a entrada, configurar a operação, visualizar o original, confirmar avisos, acompanhar/cancelar a tarefa e visualizar/descarregar os resultados. As tarefas continuam após sair da página.

Regras aplicadas:

- Todos os volumes entre 0% e 300%. Acima de 100%, pedir confirmação por risco de distorção. A mistura não aplica normalização automática.
- Remover áudio exige confirmação. Volume 0% informa sobre o silêncio e apresenta a alternativa de remover a faixa; manter 0% conserva a faixa silenciosa.
- Auxiliar em MP3, WAV, AAC ou OGG, com uma faixa de áudio, no máximo 20 MB decimais (20 000 000 bytes, conforme RN2/AUD-004 do PDF) e duração até 110% da duração do vídeo. A decisão MiB/GiB aplica-se aos vídeos de entrada, não altera este limite de áudio.
- Num vídeo sem som, permitir apenas sobreposição em modo substituir.
- Áudio curto exige escolha explícita entre repetir e deixar terminar. Em substituir, o restante fica em silêncio; em misturar, o original continua com o volume escolhido.
- Áudio que ultrapassa o fim exige confirmação do corte. O início deve ser não negativo e anterior ao fim do vídeo.
- Cada fade entre 0 e 5 segundos e soma até à duração efetiva, sem sobreposição. Na sobreposição, repetir/cortar antes de aplicar os fades uma vez ao áudio efetivo. No ajuste de volume, usar a duração da faixa original.
- Copiar o vídeo com `-c:v copy`, sem recodificar a imagem. Verificar resolução, FPS, presença/ausência de som e duração com tolerância de 0,1 segundos. O áudio é codificado em AAC para MP4/MOV ou Opus para WebM.
- O ficheiro auxiliar e as cópias temporárias são eliminados após validação/inspeção, confirmação pendente, sucesso, erro ou cancelamento. A interface reenvia o ficheiro ao confirmar; não fica um upload órfão enquanto o formulário está aberto.

As rotas públicas usam o prefixo `/projects/:user/:project/video/audio`:

| Método | Sufixo | Finalidade |
|---|---|---|
| GET | `/metadata` | Validar e consultar o vídeo guardado (`sourceResultId` opcional na query). |
| POST | `/inspect` | Validar vídeo e ficheiro auxiliar, sem criar tarefa nem reservar quota. |
| POST | vazio | Validar parâmetros/confirmações e aceitar a operação. |
| GET | `/tasks` | Recuperar tarefas de áudio do utilizador neste projeto. |
| GET / DELETE | `/tasks/:id` | Consultar / cancelar tarefa. |
| GET | `/tasks/:id/download` | Descarregar resultado concluído. |

Os POST usam multipart: `audio` é o ficheiro auxiliar; os restantes campos são `operation` (`volume`, `remove`, `overlay`), `volume`, `originalVolume`, `overlayMode` (`mix`, `replace`), `startSeconds`, `fadeIn`, `fadeOut`, `shortPolicy` (`repeat`, `silence`) e, opcionalmente, `sourceResultId`. As confirmações usam `confirmRemove`, `confirmAmplification`, `confirmTrim` e `confirmZero`, com valor `true`. Campos sem aplicação na operação escolhida não acrescentam outras operações.

As rotas de `/video/results` são partilhadas com o trim. Os resultados incluem metadados `processor` e `operation`; o serviço de projetos só aceita as origens internas `trim` e `audio` para copiar o ficheiro certo do volume de processamento.

O MVP não suporta múltiplas faixas de áudio, áudio auxiliar selecionado da biblioteca, normalização automática nem encadeamento de várias operações num único pedido. As questões abertas Q1–Q3 do PDF não foram tratadas como funcionalidades aprovadas.
