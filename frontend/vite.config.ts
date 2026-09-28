import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// No dev proxy: the browser calls the API on localhost:3000 directly, so CORS is exercised
// exactly as it is when the frontend and backend are deployed on different origins.
export default defineConfig({
	plugins: [vue()],
	server: { port: 5173, strictPort: true },
});
