import { describe, it, expect } from "vitest";
import {
  buildInterfaceSignature,
  extractPackageName,
} from "../../src/extractor/utilities.js";

describe("buildInterfaceSignature", () => {
  it("extrae la cabecera de una interfaz con cuerpo", () => {
    const result = buildInterfaceSignature(
      "export interface IOrderService {\n  createOrder(dto: CreateOrderDto): Promise<Order>;\n}"
    );
    expect(result).toBe("export interface IOrderService {}");
  });

  it("preserva el texto si no hay llave de apertura", () => {
    const result = buildInterfaceSignature("interface Empty");
    expect(result).toBe("interface Empty");
  });

  it("trunca en la primera llave y preserva espacios del prefijo", () => {
    const result = buildInterfaceSignature("export interface IHandler<T> { process(): void; }");
    expect(result).toBe("export interface IHandler<T> {}");
  });

  it("maneja interfaz con extends", () => {
    const result = buildInterfaceSignature(
      "export interface IRepo extends IReadRepo, IWriteRepo {\n  find(): T;\n}"
    );
    expect(result).toBe("export interface IRepo extends IReadRepo, IWriteRepo {}");
  });
});

describe("extractPackageName", () => {
  it("extrae el nombre de paquete simple de una ruta node_modules", () => {
    const result = extractPackageName(
      "/project/node_modules/express/index.d.ts"
    );
    expect(result).toBe("express");
  });

  it("extrae el nombre de paquete scoped (@org/pkg)", () => {
    const result = extractPackageName(
      "/project/node_modules/@nestjs/common/index.d.ts"
    );
    expect(result).toBe("@nestjs/common");
  });

  it("extrae @types correctamente", () => {
    const result = extractPackageName(
      "/project/node_modules/@types/express/index.d.ts"
    );
    expect(result).toBe("@types/express");
  });

  it("devuelve 'unknown' para rutas sin node_modules", () => {
    const result = extractPackageName("/project/src/order.service.ts");
    expect(result).toBe("unknown");
  });

  it("maneja ruta con multiples ocurrencias de node_modules", () => {
    const result = extractPackageName(
      "/project/node_modules/pkg-a/node_modules/nested/index.js"
    );
    expect(result).toBe("nested");
  });

  it("maneja paquete scoped con subdirectorio profundo", () => {
    const result = extractPackageName(
      "/app/node_modules/@myorg/mylib/dist/index.d.ts"
    );
    expect(result).toBe("@myorg/mylib");
  });
});
