# Processamento de vídeo

O `server.py` mantém as rotas de redimensionamento (UC1) e regista o módulo de corte (UC2). O `trim.py` contém a lógica de corte; `trim_integration.py` autentica os pedidos internos e liga a quota e os resultados aos serviços `users` e `projects`.

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

O perfil Gratuito tem no máximo uma tarefa de trim ativa. O Premium pode aceitar várias, que são executadas pela fila local do módulo. A concorrência das rotas de resize existentes não foi reorganizada nesta alteração.

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
