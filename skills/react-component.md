# React Component Skill

Use this skill when building or modifying React components.

## Conventions
- Use TypeScript (`.tsx`)
- Use functional components with hooks
- Props defined as TypeScript interfaces
- Each component in its own file
- CSS modules or Tailwind for styling
- React Testing Library + Vitest for tests

## Component structure
```typescript
// MyComponent.tsx
interface MyComponentProps {
  title: string;
  onAction: () => void;
}

export function MyComponent({ title, onAction }: MyComponentProps) {
  return <div>{title}</div>;
}
```
