import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({plugins:[svelte()],build:{manifest:true},server:{proxy:{'/ws':{target:'ws://relay:3000',ws:true}}},define:{__APP_VERSION__:JSON.stringify(process.env.npm_package_version??'dev'),__SOURCE_COMMIT__:JSON.stringify(process.env.SOURCE_COMMIT??'development')}});
