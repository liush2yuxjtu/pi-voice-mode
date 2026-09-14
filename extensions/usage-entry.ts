import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import voiceMode from './voice-mode.ts';
import { createUsageFunnel } from './usage-funnel.ts';

const version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

export default function usageInstrumentedVoiceMode(pi: ExtensionAPI): void {
  const funnel = createUsageFunnel('pi-voice-mode', version);
  pi.on('session_start', () => { void funnel.launch(); });

  const instrumented = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== 'on') return Reflect.get(target, property, receiver);
      return (eventName: any, handler: any) => {
        if (eventName !== 'before_agent_start' || typeof handler !== 'function') return (target.on as any)(eventName, handler);
        return (target.on as any)(eventName, (...args: any[]) => {
          const output = handler(...args);
          if (output && typeof output.then === 'function') {
            return output.then((result: any) => { if (result) void funnel.success(); return result; });
          }
          if (output) void funnel.success();
          return output;
        });
      };
    },
  }) as ExtensionAPI;

  voiceMode(instrumented);
}
