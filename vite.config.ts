import {defineConfig} from 'vite';
export default defineConfig({build:{rollupOptions:{input:{workbench:'index.html',materials:'materials.html'}}}});
