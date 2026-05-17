import pygame
import random
import sys

# 颜色定义
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
RED = (255, 0, 0)
GREEN = (0, 255, 0)
BLUE = (0, 0, 255)
YELLOW = (255, 255, 0)

# 游戏配置
SCREEN_WIDTH = 800
SCREEN_HEIGHT = 600
TANK_SIZE = 40
BULLET_SIZE = 5
TANK_SPEED = 4
BULLET_SPEED = 7
ENEMY_SPEED = 2


class Tank:
    def __init__(self, x, y, color):
        self.rect = pygame.Rect(x, y, TANK_SIZE, TANK_SIZE)
        self.color = color
        self.direction = 'UP'  # UP, DOWN, LEFT, RIGHT
        self.bullets = []

    def move(self, dx, dy):
        self.rect.x += dx
        self.rect.y += dy
        # 边界检查
        self.rect.clamp_ip(pygame.Rect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT))

    def shoot(self):
        bullet = pygame.Rect(0, 0, BULLET_SIZE, BULLET_SIZE)
        bullet.center = self.rect.center
        self.bullets.append(bullet)

    def update_bullets(self):
        for bullet in self.bullets[:]:
            if self.direction == 'UP':
                bullet.y -= BULLET_SPEED
            elif self.direction == 'DOWN':
                bullet.y += BULLET_SPEED
            elif self.direction == 'LEFT':
                bullet.x -= BULLET_SPEED
            elif self.direction == 'RIGHT':
                bullet.x += BULLET_SPEED

            # 移除出界子弹
            if not pygame.Rect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT).colliderect(
                bullet
            ):
                self.bullets.remove(bullet)

    def draw(self, screen):
        pygame.draw.rect(screen, self.color, self.rect)
        # 绘制炮管指示方向
        center = self.rect.center
        if self.direction == 'UP':
            end_pos = (center[0], center[1] - TANK_SIZE // 2)
            pygame.draw.line(screen, WHITE, center, end_pos, 3)
        elif self.direction == 'DOWN':
            end_pos = (center[0], center[1] + TANK_SIZE // 2)
            pygame.draw.line(screen, WHITE, center, end_pos, 3)
        elif self.direction == 'LEFT':
            end_pos = (center[0] - TANK_SIZE // 2, center[1])
            pygame.draw.line(screen, WHITE, center, end_pos, 3)
        elif self.direction == 'RIGHT':
            end_pos = (center[0] + TANK_SIZE // 2, center[1])
            pygame.draw.line(screen, WHITE, center, end_pos, 3)

        for bullet in self.bullets:
            pygame.draw.ellipse(screen, YELLOW, bullet)


class EnemyTank(Tank):
    def __init__(self, x, y):
        super().__init__(x, y, RED)
        self.move_timer = 0
        self.shoot_timer = 0

    def update(self):
        # 简单的 AI: 随机移动和射击
        if self.move_timer <= 0:
            self.direction = random.choice(['UP', 'DOWN', 'LEFT', 'RIGHT'])
            self.move_timer = random.randint(30, 90)

        if self.direction == 'UP':
            self.move(0, -ENEMY_SPEED)
        elif self.direction == 'DOWN':
            self.move(0, ENEMY_SPEED)
        elif self.direction == 'LEFT':
            self.move(-ENEMY_SPEED, 0)
        elif self.direction == 'RIGHT':
            self.move(ENEMY_SPEED, 0)

        self.move_timer -= 1
        self.shoot_timer -= 1
        if self.shoot_timer <= 0:
            self.shoot()
            self.shoot_timer = random.randint(60, 120)


def main():
    pygame.init()
    screen = pygame.display.set_mode((SCREEN_WIDTH, SCREEN_HEIGHT))
    pygame.display.set_caption("坦克大战 - Python Edition")
    clock = pygame.time.Clock()

    player = Tank(SCREEN_WIDTH // 2, SCREEN_HEIGHT - 60, GREEN)
    enemies = [
        EnemyTank(
            random.randint(0, SCREEN_WIDTH - TANK_SIZE),
            random.randint(0, SCREEN_HEIGHT // 3),
        )
        for _ in range(3)
    ]

    score = 0
    game_over = False

    while not game_over:
        screen.fill(BLACK)

        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

        # 玩家控制
        keys = pygame.key.get_pressed()
        if keys[pygame.K_LEFT]:
            player.direction = 'LEFT'
            player.move(-TANK_SPEED, 0)
        elif keys[pygame.K_RIGHT]:
            player.direction = 'RIGHT'
            player.move(TANK_SPEED, 0)
        elif keys[pygame.K_UP]:
            player.direction = 'UP'
            player.move(0, -TANK_SPEED)
        elif keys[pygame.K_DOWN]:
            player.direction = 'DOWN'
            player.move(0, TANK_SPEED)

        if keys[pygame.K_SPACE]:
            if len(player.bullets) < 5:  # 限制子弹数量
                player.shoot()

        # 更新玩家子弹
        player.update_bullets()

        # 更新敌人
        for enemy in enemies[:]:
            enemy.update()
            enemy.update_bullets()

            # 检查玩家子弹是否击中敌人
            for bullet in player.bullets[:]:
                if enemy.rect.colliderect(bullet):
                    enemies.remove(enemy)
                    player.bullets.remove(bullet)
                    score += 1
                    # 产生新敌人
                    enemies.append(
                        EnemyTank(
                            random.randint(0, SCREEN_WIDTH - TANK_SIZE),
                            random.randint(0, SCREEN_HEIGHT // 3),
                        )
                    )
                    break

            # 检查敌人子弹是否击中玩家
            for bullet in enemy.bullets[:]:
                if player.rect.colliderect(bullet):
                    game_over = True

        # 绘制所有物体
        player.draw(screen)
        for enemy in enemies:
            enemy.draw(screen)

        # 显示分数
        font = pygame.font.SysFont(None, 36)
        score_text = font.render(f"Score: {score}", True, WHITE)
        screen.blit(score_text, (10, 10))

        pygame.display.flip()
        clock.tick(60)

    # 游戏结束界面
    screen.fill(BLACK)
    font = pygame.font.SysFont(None, 72)
    text = font.render("GAME OVER", True, RED)
    screen.blit(text, (SCREEN_WIDTH // 2 - 150, SCREEN_HEIGHT // 2 - 36))
    pygame.display.flip()
    pygame.time.wait(3000)
    pygame.quit()


if __name__ == "__main__":
    main()
