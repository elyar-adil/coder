import curses
import random
import time

# Tetromino shapes
SHAPES = {
    'I': [[(0, 0), (0, 1), (0, 2), (0, 3)]],
    'O': [[(0, 0), (0, 1), (1, 0), (1, 1)]],
    'T': [[(0, 1), (1, 0), (1, 1), (1, 2)], [(0, 1), (1, 1), (2, 1), (1, 2)], [(2, 1), (1, 0), (1, 1), (1, 2)], [(1, 1), (0, 1), (1, 2), (2, 1)]],
    'S': [[(0, 1), (0, 2), (1, 0), (1, 1)], [(0, 0), (1, 0), (1, 1), (2, 1)]],
    'Z': [[(0, 0), (0, 1), (1, 1), (1, 2)], [(0, 1), (1, 1), (1, 0), (2, 0)]],
    'J': [[(0, 0), (1, 0), (1, 1), (1, 2)], [(0, 0), (0, 1), (0, 2), (1, 2)], [(1, 0), (2, 0), (2, 1), (2, 2)], [(0, 1), (0, 2), (1, 2), (2, 2)]],
    'L': [[(0, 2), (1, 0), (1, 1), (1, 2)], [(0, 0), (0, 1), (0, 2), (1, 0)], [(1, 0), (1, 1), (1, 2), (2, 2)], [(0, 1), (1, 1), (2, 1), (2, 0)]]
}

COLORS = [curses.COLOR_RED, curses.COLOR_GREEN, curses.COLOR_BLUE, curses.COLOR_YELLOW, curses.COLOR_MAGENTA, curses.COLOR_CYAN, curses.COLOR_WHITE]

class Tetris:
    def __init__(self, height=20, width=10):
        self.height = height
        self.width = width
        self.board = [[0 for _ in range(width)] for _ in range(height)]
        self.score = 0
        self.game_over = False
        self.current_piece = self.new_piece()

    def new_piece(self):
        shape_key = random.choice(list(SHAPES.keys()))
        color = random.choice(COLORS)
        # Initial position: top center
        return {
            'shape': SHAPES[shape_key],
            'rotation': 0,
            'x': self.width // 2 - 1,
            'y': 0,
            'color': color
        }

    def rotate(self, piece):
        # For simplicity, we'll cycle through pre-defined rotations for complex shapes
        # or just use a simple rotation for I, O etc.
        # In this simplified implementation, we assume the SHAPES dict contains rotations for some
        # but for most we'll just rotate the coordinates manually
        shape = piece['shape']
        # Simple 90 deg rotation: (r, c) -> (c, -r)
        current_coords = piece['shape'][piece['rotation']]
        # This implementation uses pre-defined rotations for some, let's simplify
        # we'll just use the rotation index if the shape has multiple options
        if len(shape) > 1:
            piece['rotation'] = (piece['rotation'] + 1) % len(shape)
        return piece

    def collide(self, piece, dx=0, dy=0, rotation=None):
        if rotation is None: rotation = piece['rotation']
        coords = piece['shape'][rotation]
        for r, c in coords:
            new_x, new_y = piece['x'] + c + dx, piece['y'] + r + dy
            if new_x < 0 or new_x >= self.width or new_y >= self.height:
                return True
            if new_y >= 0 and self.board[new_y][new_x]:
                return True
        return False

    def freeze(self):
        coords = self.current_piece['shape'][self.current_piece['rotation']]
        for r, c in coords:
            x, y = self.current_piece['x'] + c, self.current_piece['y'] + r
            if y >= 0:
                self.board[y][x] = self.current_piece['color']
        self.clear_lines()
        self.current_piece = self.new_piece()
        if self.collide(self.current_piece):
            self.game_over = True

    def clear_lines(self):
        lines_to_clear = [i for i, row in enumerate(self.board) if all(row)]
        for i in lines_to_clear:
            del self.board[i]
            self.board.insert(0, [0 for _ in range(self.width)])
            self.score += 100

    def move(self, dx, dy):
        if not self.collide(self.current_piece, dx, dy):
            self.current_piece['x'] += dx
            self.current_piece['y'] += dy
            return True
        if dy > 0:
            self.freeze()
        return False

def main(stdscr):
    curses.curs_set(0)
    stdscr.nodelay(True)
    stdscr.timeout(100)
    curses.start_color()
    
    # Initialize colors
    for i in range(1, 8):
        curses.init_pair(i, i, curses.COLOR_BLACK)

    game = Tetris()
    last_drop = time.time()
    drop_interval = 0.5

    while not game.game_over:
        stdscr.clear()
        
        # Draw board
        for y, row in enumerate(game.board):
            for x, val in enumerate(row):
                if val:
                    stdscr.addch(y + 1, x * 2 + 1, '[]', curses.color_pair(val if val < 8 else 1))
                else:
                    stdscr.addch(y + 1, x * 2 + 1, ' . '[:1])

        # Draw current piece
        piece = game.current_piece
        coords = piece['shape'][piece['rotation']]
        for r, c in coords:
            px, py = piece['x'] + c, piece['y'] + r
            if py >= 0:
                stdscr.addch(py + 1, px * 2 + 1, '[]', curses.color_pair(piece['color'] if piece['color'] < 8 else 1))

        # Draw border
        for y in range(game.height + 2):
            stdscr.addch(y, 0, '|')
            stdscr.addch(y, game.width * 2 + 1, '|')
        stdscr.addstr(game.height + 2, 0, '--------------------')
        stdscr.addstr(0, 2, f"Score: {game.score}")

        # Input
        key = stdscr.getch()
        if key == curses.KEY_LEFT: game.move(-1, 0)
        elif key == curses.KEY_RIGHT: game.move(1, 0)
        elif key == curses.KEY_DOWN: game.move(0, 1)
        elif key == curses.KEY_UP: 
            old_rot = game.current_piece['rotation']
            game.rotate(game.current_piece)
            if game.collide(game.current_piece):
                game.current_piece['rotation'] = old_rot
        elif key == ord('q'):
            break

        # Gravity
        if time.time() - last_drop > drop_interval:
            game.move(0, 1)
            last_drop = time.time()

        stdscr.refresh()

    stdscr.nodelay(False)
    stdscr.addstr(game.height // 2, game.width // 2, "GAME OVER!")
    stdscr.refresh()
    stdscr.getch()

if __name__ == "__main__":
    curses.wrapper(main)
