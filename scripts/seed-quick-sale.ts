import mongoose from 'mongoose';

type CatalogItem = {
  name: string;
  code: string;
  category: string;
  price: number;
  unitLabel?: string;
  priceDisplayMode: 'FIXED' | 'STARTING_AT';
};

const CATALOG: CatalogItem[] = [
  {
    name: 'ถ่ายเอกสาร A4 ขาวดำ',
    code: 'qs-a4-bw',
    category: 'งานเอกสาร',
    price: 3,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'ถ่ายเอกสาร A4 สี',
    code: 'qs-a4-color',
    category: 'งานเอกสาร',
    price: 5,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'ถ่ายเอกสาร A3 ขาวดำ',
    code: 'qs-a3-bw',
    category: 'งานเอกสาร',
    price: 4,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'ถ่ายเอกสาร A3 สี',
    code: 'qs-a3-color',
    category: 'งานเอกสาร',
    price: 10,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'ปริ้นท์ A4 ขาวดำ',
    code: 'qs-print-a4-bw',
    category: 'งานเอกสาร',
    price: 3,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'ปริ้นท์ A4 สี',
    code: 'qs-print-a4-color',
    category: 'งานเอกสาร',
    price: 5,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'ปริ้นท์ A3 ขาวดำ',
    code: 'qs-print-a3-bw',
    category: 'งานเอกสาร',
    price: 4,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'ปริ้นท์ A3 สี',
    code: 'qs-print-a3-color',
    category: 'งานเอกสาร',
    price: 10,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'สแกนเอกสาร',
    code: 'qs-scan',
    category: 'งานเอกสาร',
    price: 10,
    unitLabel: 'หน้า',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'เคลือบ A4',
    code: 'qs-laminate-a4',
    category: 'เคลือบ / ตัด',
    price: 20,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'เคลือบ A3',
    code: 'qs-laminate-a3',
    category: 'เคลือบ / ตัด',
    price: 40,
    unitLabel: 'แผ่น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'เข้าเล่มสันเกลียว',
    code: 'qs-spiral-binding',
    category: 'เข้าเล่ม',
    price: 60,
    unitLabel: 'เล่ม',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'สติ๊กเกอร์',
    code: 'qs-sticker',
    category: 'สติ๊กเกอร์',
    price: 200,
    priceDisplayMode: 'STARTING_AT',
  },
  {
    name: 'โปสเตอร์',
    code: 'qs-poster',
    category: 'งานพิมพ์',
    price: 100,
    priceDisplayMode: 'STARTING_AT',
  },
  {
    name: 'พิมพ์แบบแปลน A0',
    code: 'qs-blueprint-a0',
    category: 'งานพิมพ์',
    price: 80,
    priceDisplayMode: 'STARTING_AT',
  },
  {
    name: 'นามบัตร',
    code: 'qs-business-card',
    category: 'งานพิมพ์',
    price: 300,
    priceDisplayMode: 'STARTING_AT',
  },
  {
    name: 'แฟ้มใส่เอกสาร',
    code: 'qs-document-folder',
    category: 'อื่นๆ',
    price: 20,
    unitLabel: 'ชิ้น',
    priceDisplayMode: 'FIXED',
  },
  {
    name: 'พิมพ์ภาพ Photo',
    code: 'qs-photo-print',
    category: 'งานพิมพ์',
    price: 15,
    priceDisplayMode: 'STARTING_AT',
  },
  {
    name: 'ซองเอกสาร',
    code: 'qs-envelope',
    category: 'อื่นๆ',
    price: 10,
    unitLabel: 'ชิ้น',
    priceDisplayMode: 'FIXED',
  },
];

async function seed(): Promise<void> {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  const products = mongoose.connection.collection('products');
  const quickProducts = mongoose.connection.collection('quick_products');
  const catalogCodes = CATALOG.map((item) => item.code);

  await quickProducts.deleteMany({ code: { $nin: catalogCodes } });

  for (const [index, item] of CATALOG.entries()) {
    await quickProducts.updateOne(
      { code: item.code },
      {
        $set: {
          name: item.name,
          code: item.code,
          typeCode: item.code,
          category: item.category,
          active: true,
          quickSaleEnabled: true,
          isHotMenu: index < 12,
          quickSaleSortOrder: index + 1,
          ...(item.unitLabel ? { unitLabel: item.unitLabel } : {}),
          priceDisplayMode: item.priceDisplayMode,
          variants: [
            {
              name: 'Default',
              code: `${item.code}-default`,
              price: item.price,
              active: true,
              sortOrder: 1,
            },
          ],
        },
        $unset: {
          deletedAt: '',
          ...(item.unitLabel ? {} : { unitLabel: '' }),
        },
      },
      { upsert: true },
    );
  }

  await products.deleteMany({ code: /^qs-/, name: { $ne: 'นามบัตร' } });
  await products.updateOne(
    { name: 'นามบัตร' },
    {
      $set: {
        category: 'นามบัตร',
        active: true,
        quickSaleEnabled: false,
        isHotMenu: false,
        variants: [{ name: 'default', price: 300, active: true, sortOrder: 1 }],
      },
      $unset: {
        code: '',
        typeCode: '',
        quickSaleSortOrder: '',
        unitLabel: '',
        priceDisplayMode: '',
      },
    },
  );

  console.log(
    `Quick Sale catalog seeded into quick_products: ${CATALOG.length} items`,
  );
  await mongoose.disconnect();
}

void seed().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
