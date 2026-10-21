set -eu
mkdir -p /tmp/frontend
tar -C /source/frontend --exclude=node_modules --exclude=.next -cf - . | tar -C /tmp/frontend -xf -
ln -s /usr/src/app/node_modules /tmp/frontend/node_modules
mkdir -p /tmp/frontend/app/uc2-test
cp /source/videoProcessing/tests/integration/ui-page.tsx /tmp/frontend/app/uc2-test/page.tsx
cp /validation/ui-context.json /tmp/frontend/public/context.json
cp /validation/fixtures/source.mp4 /tmp/frontend/public/fixture.mp4
cat > /tmp/frontend/app/layout.tsx <<'LAYOUT'
import "./globals.css";
import ReactQueryProvider from "@/components/query-client";
export default function Layout({children}:{children:React.ReactNode}){
 return <html lang="pt"><body><ReactQueryProvider>{children}</ReactQueryProvider></body></html>;
}
LAYOUT
cat > /tmp/frontend/next.config.ts <<'CONFIG'
export default {async rewrites(){return [{source:'/api-gateway/:path*',destination:'http://api_gateway:8000/:path*'}]}};
CONFIG
cd /tmp/frontend
exec /usr/src/app/node_modules/.bin/next dev --hostname 0.0.0.0 --port 3000
