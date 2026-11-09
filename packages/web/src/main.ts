import { mount } from "svelte";
import App from "./App.svelte";
import { stripTokenFromUrl } from "./lib/api.js";
import "./app.css";

// The daemon set its HttpOnly cookie on this page's response; the token must not linger in the
// address bar or history.
stripTokenFromUrl();

mount(App, { target: document.getElementById("app")! });
