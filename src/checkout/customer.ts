import type { BuPaymentClient, Customer } from "@bu-payment/node-sdk";

export async function customerFor(
  customers: BuPaymentClient["customers"],
  email: string,
): Promise<Customer> {
  const page = await customers.list().email(email).limit(1).get();
  return page.data[0] ?? (await customers.draft().email(email).create());
}
