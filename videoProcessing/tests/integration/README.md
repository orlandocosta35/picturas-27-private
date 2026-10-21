# Testes de integração do UC2

Este ambiente usa uma rede Docker própria, MongoDB temporário e volumes próprios. Não acede às bases de dados nem aos volumes da aplicação habitual. Os serviços HTTP usam os routers reais, com um pequeno servidor de teste que dispensa RabbitMQ e as ferramentas de imagem.

É necessário ter as imagens locais das dependências e construir a imagem de vídeo. Na raiz do projeto:

```sh
docker compose build users projects api_gateway
docker compose -f videoProcessing/tests/integration/compose.yaml build video_processing
docker compose -f videoProcessing/tests/integration/compose.yaml up -d
```

Gerar o vídeo de teste e executar os testes:

```sh
docker compose -f videoProcessing/tests/integration/compose.yaml exec -T video_processing mkdir -p /validation/fixtures
docker compose -f videoProcessing/tests/integration/compose.yaml exec -T video_processing ffmpeg -v error -y -f lavfi -i testsrc2=size=160x96:rate=12:duration=6 -f lavfi -i sine=frequency=440:duration=6 -c:v libx264 -threads 2 -g 12 -keyint_min 12 -sc_threshold 0 -bf 2 -c:a aac /validation/fixtures/source.mp4
docker compose -f videoProcessing/tests/integration/compose.yaml exec -T video_processing python -m unittest discover -s /source/videoProcessing/tests -p "test_*.py"
docker compose -f videoProcessing/tests/integration/compose.yaml exec -T projects node /source/videoProcessing/tests/integration/run.js
```

O teste entre serviços limpa apenas as coleções da base temporária `uc2`. Verifica os modos de corte, a confirmação, a publicação/download, autenticação, isolamento entre utilizadores, quota partilhada, concorrência, idempotência, mudança de dia e regressão do resize.

No fim, remover o ambiente e os seus volumes de teste:

```sh
docker compose -f videoProcessing/tests/integration/compose.yaml down -v
```

## Interface no Chrome (opcional, Linux)

Construir também a imagem `frontend` da aplicação. Depois dos testes anteriores, arrancar a página temporária que importa o componente real de trim:

```sh
docker compose -f videoProcessing/tests/integration/compose.yaml -f videoProcessing/tests/integration/browser.compose.yaml up -d frontend
```

Noutro terminal, abrir um Chrome com perfil de teste separado:

```sh
google-chrome --headless --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-port=19223 --user-data-dir=/tmp/picturas-uc2-browser about:blank
```

Executar o teste de navegador através do protocolo DevTools. A imagem Node usada no teste deve disponibilizar `fetch` e `WebSocket` globais:

```sh
docker run --rm --network host --volumes-from picturas-uc2-validation-frontend-1 --entrypoint node picturas-projects:latest /source/videoProcessing/tests/integration/browser.js
```

O teste verifica carregamento dos metadados, intervalo completo sem operação, confirmação do Rápido, conclusão dos dois modos, atualização e recuperação da biblioteca e exceções do navegador. A captura `trim-ui.png` fica no volume de teste `workspace`.

A página de teste substitui apenas o layout/configuração da cópia temporária do frontend, sem alterar a aplicação. Executar uma instância do teste de navegador de cada vez. Para repetir com uma quota limpa, repetir o teste Node entre serviços e recriar o frontend de teste.

No fim, fechar o Chrome de teste e remover também o serviço adicional:

```sh
docker compose -f videoProcessing/tests/integration/compose.yaml -f videoProcessing/tests/integration/browser.compose.yaml down -v
```
