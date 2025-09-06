import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ✅ ระบุ origin ที่อนุญาต (Frontend Dev + Prod)
  app.enableCors({
    origin: [
      'http://localhost:3000',             // Dev frontend
      'https://glossy-design.vercel.app',  // Prod frontend
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // ✅ Validation pipe
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // ✅ Cloud Run จะ set PORT เอง
  const port = process.env.PORT || 8080;
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 API running on port ${port}`);
}
bootstrap();
