import { TestApp, type Fault } from './harness.ts';
const app = await new TestApp().start(process.argv[2]);
app.setFault((process.argv[3] ?? 'none') as Fault);
process.send?.({ type: 'ready', origin: app.origin, node: process.version });
if (app.fault === 'gate-before-effect' || app.fault === 'gate-after-effect') {
  void app.waitForGate().then(() => process.send?.({ type: 'gate', phase: app.fault, demands: app.countDemands(), formPosts: app.formPosts }));
}
process.on('message', message => {
  if (message === 'inspect') process.send?.({ type: 'stats', browserLaunches: app.browserLaunches, formPosts: app.formPosts, formGets: app.formGets, demandCount: app.countDemands() });
});
process.once('SIGTERM', () => { void app.stop().then(() => process.exit(0)); });
