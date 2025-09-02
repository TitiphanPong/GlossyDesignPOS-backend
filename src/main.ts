import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ✅ ระบุ origin ที่อนุญาตแบบชัดเจน (สำคัญมากสำหรับ Cloud Run)
  app.enableCors({
    origin: ['https://glossy-design.vercel.app', 'http://localhost:3000'], // ✅ ใส่ domain จริงของ frontend
    methods: 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT || 8080;
  await app.listen(port, '0.0.0.0');
  console.log(`API running on http://localhost:${port}`);
}
bootstrap();
