import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { assetCatalog } from './vitePlugins/assetCatalog.ts';

export default defineConfig({
    server: {
        host: true,
        https: true,
    },
    plugins: [
        basicSsl(),
        assetCatalog(),
    ]
});
