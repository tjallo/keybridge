import { test, expect } from '@playwright/test';
test('complete Sender to Receiver encrypted text flow', async ({ browser, baseURL }) => {
  const senderContext = await browser.newContext(),
    receiverContext = await browser.newContext();
  const requests: string[] = [];
  const sender = await senderContext.newPage();
  sender.on('request', (request) => requests.push(request.url()));
  await sender.goto(baseURL!);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const link = await sender.getByLabel('Pairing link').inputValue();
  expect(link).toContain('/#room=');
  const pin = (await sender.locator('.pin strong').textContent())!;
  const receiver = await receiverContext.newPage();
  await receiver.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }),
  );
  await receiver.goto(link);
  await expect(receiver).not.toHaveURL(/#/);
  await receiver.getByLabel('PIN').fill(pin);
  await receiver.getByRole('button', { name: 'Request pairing' }).click();
  await expect(sender.getByText('A Receiver supplied the correct PIN')).toBeVisible();
  await sender.getByRole('button', { name: 'Approve' }).click();
  await expect(receiver.getByText('Paired. Secret values stay hidden')).toBeVisible();
  await sender.getByLabel('Label').fill('<b>Token</b>');
  await sender.getByLabel('Secret text').fill('KNOWN-PLAINTEXT-SENTINEL');
  await sender.getByRole('button', { name: 'Send secret' }).click();
  const card = receiver.getByRole('article', { name: 'Secret <b>Token</b>' });
  await expect(card).toContainText('••••');
  await card.getByRole('button', { name: 'Reveal' }).click();
  await expect(card.locator('pre')).toHaveText('KNOWN-PLAINTEXT-SENTINEL');
  await card.getByRole('button', { name: 'Copy' }).click();
  await expect(card.getByText('Select the revealed value')).toBeVisible();
  await receiver.reload();
  await expect(card).toContainText('••••');
  await card.getByRole('button', { name: 'Reveal' }).click();
  await expect(receiver.getByText('KNOWN-PLAINTEXT-SENTINEL')).toBeVisible();
  await card.getByRole('button', { name: 'Revoke' }).click();
  await expect(card).toHaveCount(0);
  expect(requests.every((url) => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);
  await senderContext.close();
  await receiverContext.close();
});
test('security headers, transparency, fragment removal, and second Receiver rejection', async ({
  browser,
  request,
  baseURL,
}) => {
  const response = await request.get('/');
  expect(response.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
  expect(response.headers()['cache-control']).toBe('no-store');
  const sender = await browser.newPage();
  await sender.goto(baseURL!);
  await sender.getByRole('button', { name: 'Security & transparency' }).click();
  await expect(sender.getByText('no forward secrecy', { exact: false })).toBeVisible();
  await sender.goto(baseURL!);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const link = await sender.getByLabel('Pairing link').inputValue(),
    pin = (await sender.locator('.pin strong').textContent())!;
  const first = await browser.newPage();
  await first.goto(link);
  await first.getByLabel('PIN').fill(pin);
  await first.getByRole('button', { name: 'Request pairing' }).click();
  const second = await browser.newPage();
  await second.goto(link);
  await expect(second.getByRole('alert')).toContainText('room_unavailable');
});
