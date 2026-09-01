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
  await expect(card.getByLabel('Value for <b>Token</b>')).toHaveValue('••••••••••••');
  await card.getByRole('button', { name: 'Reveal' }).click();
  await expect(card.getByLabel('Value for <b>Token</b>')).toHaveValue('KNOWN-PLAINTEXT-SENTINEL');
  await card.getByRole('button', { name: 'Copy' }).click();
  await expect(card.getByText('Select the revealed value')).toBeVisible();
  expect(
    await card.getByLabel('Value for <b>Token</b>').evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
    })),
  ).toEqual({ start: 0, end: 'KNOWN-PLAINTEXT-SENTINEL'.length });
  await receiver.reload();
  await expect(card.getByLabel('Value for <b>Token</b>')).toHaveValue('••••••••••••');
  await card.getByRole('button', { name: 'Reveal' }).click();
  await expect(card.getByLabel('Value for <b>Token</b>')).toHaveValue('KNOWN-PLAINTEXT-SENTINEL');
  await card.getByRole('button', { name: 'Revoke' }).click();
  await expect(card).toHaveCount(0);
  await receiver.reload();
  await expect(card).toHaveCount(0);
  expect(requests.every((url) => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);
  await senderContext.close();
  await receiverContext.close();
});

test('wrong PIN rejection recovers and Sender reload preserves approval', async ({
  browser,
  baseURL,
}) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  await sender.goto(baseURL!);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const link = await sender.getByLabel('Pairing link').inputValue();
  await receiver.goto(link);
  await receiver.getByLabel('PIN').fill('2345-6789');
  await receiver.getByRole('button', { name: 'Request pairing' }).click();
  await expect(sender.getByText('Pairing authentication failed')).toBeVisible();
  await sender.getByRole('button', { name: 'Reject' }).click();
  await expect(receiver.getByText('Enter the new PIN')).toBeVisible();
  await expect(sender.locator('.status')).toContainText('Waiting for Receiver');
  const newPin = (await sender.locator('.pin strong').textContent())!;
  await expect(receiver.getByLabel('PIN')).toBeVisible();
  await receiver.getByLabel('PIN').fill(newPin);
  await receiver.getByRole('button', { name: 'Request pairing' }).click();
  await expect(sender.getByText('A Receiver supplied the correct PIN')).toBeVisible();
  await sender.reload();
  await expect(sender.getByText('A Receiver supplied the correct PIN')).toBeVisible();
  await sender.getByRole('button', { name: 'Approve' }).click();
  await expect(receiver.getByText('Paired. Secret values stay hidden')).toBeVisible();
  await senderContext.close();
  await receiverContext.close();
});

test('Relay rejection preserves unsent Sender input', async ({ browser, baseURL }) => {
  const sender = await browser.newPage();
  const receiver = await browser.newPage();
  await sender.goto(baseURL!);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const link = await sender.getByLabel('Pairing link').inputValue();
  const pin = (await sender.locator('.pin strong').textContent())!;
  await receiver.goto(link);
  await receiver.getByLabel('PIN').fill(pin);
  await receiver.getByRole('button', { name: 'Request pairing' }).click();
  await sender.getByRole('button', { name: 'Approve' }).click();
  await expect(receiver.getByText('Paired. Secret values stay hidden')).toBeVisible();
  for (let index = 0; index < 10; index++) {
    await sender.getByLabel('Label').fill(`Item ${index}`);
    await sender.getByLabel('Secret text').fill(`value-${index}`);
    await sender.getByRole('button', { name: 'Send secret' }).click();
  }
  await sender.getByLabel('Label').fill('Unsent item');
  await sender.getByLabel('Secret text').fill('must remain');
  await sender.getByRole('button', { name: 'Send secret' }).click();
  await expect(sender.getByRole('alert')).toContainText('input has been preserved');
  await expect(sender.getByLabel('Label')).toHaveValue('Unsent item');
  await expect(sender.getByLabel('Secret text')).toHaveValue('must remain');
  await expect(sender.getByRole('article')).toHaveCount(10);
});

test('terminal resume failure clears session credentials', async ({ page, baseURL }) => {
  await page.goto(baseURL!);
  await page.evaluate(() =>
    sessionStorage.setItem(
      'keybridge.room',
      JSON.stringify({
        role: 'sender',
        roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
        roomKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        pin: '23456789',
        credential: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }),
    ),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('expired or is no longer available', {
    timeout: 5000,
  });
  expect(await page.evaluate(() => sessionStorage.getItem('keybridge.room'))).toBeNull();
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
  expect(response.headers()['permissions-policy']).toContain('accelerometer=()');
  expect(response.headers()['permissions-policy']).toContain('gyroscope=()');
  expect(response.headers()['permissions-policy']).toContain('magnetometer=()');
  const sender = await browser.newPage();
  await sender.goto(baseURL!);
  await sender.getByRole('button', { name: 'Security & transparency' }).click();
  await expect(sender.getByText('no forward secrecy', { exact: false })).toBeVisible();
  await sender.goto(baseURL!);
  await sender.getByRole('button', { name: 'Create room' }).click();
  const pairingQr = sender.getByLabel('Pairing QR code');
  await expect
    .poll(() => pairingQr.evaluate((element) => (element as HTMLCanvasElement).width))
    .toBeGreaterThan(116);
  expect(
    await pairingQr.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, 16).data;
      return Array.from(pixels).every((value, index) => index % 4 === 3 || value === 255);
    }),
  ).toBe(true);
  const malformed = await browser.newPage();
  await malformed.goto(`${baseURL}/#room=AAAAAAAAAAAAAAAAAAAAAA&key=%25`);
  await expect(malformed.getByRole('alert')).toContainText('Invalid pairing link');
  const link = await sender.getByLabel('Pairing link').inputValue(),
    pin = (await sender.locator('.pin strong').textContent())!;
  const first = await browser.newPage();
  await first.goto(link);
  await first.getByLabel('PIN').fill(pin);
  await first.getByRole('button', { name: 'Request pairing' }).click();
  const second = await browser.newPage();
  await second.goto(link);
  await expect(second.getByRole('alert')).toContainText('room is no longer available');
});
