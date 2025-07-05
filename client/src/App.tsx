import {Component, createSignal, For, createResource, Show} from 'solid-js';
import {Interface} from "./Interface";

export type ServerConfig = { cert_digest_base64: string, default_port: number };

const App: Component = () => {
    const [config, setConfig] = createSignal<ServerConfig>();

    fetch("http://localhost:8080/config.json")
        .then(response => response.json())
        .then(data => setConfig(data) && console.log('Config:', data))
        .catch(error => console.error('Error:', error));

    return (
        <Show when={config()} fallback={<div>Loading...</div>}>
            <Interface config={config()!}/>
        </Show>
    )
};

export default App;
