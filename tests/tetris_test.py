import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import unittest
from unittest.mock import patch, MagicMock

sys.modules['curses'] = MagicMock()
sys.modules['_curses'] = MagicMock()
import curses
curses.COLOR_RED = 1
curses.COLOR_GREEN = 2
curses.COLOR_BLUE = 3
curses.COLOR_YELLOW = 4
curses.COLOR_MAGENTA = 5
curses.COLOR_CYAN = 6
curses.COLOR_WHITE = 7

from tetris import Tetris, SHAPES, COLORS

class TestTetrisBoard(unittest.TestCase):
    def setUp(self):
        self.game = Tetris(height=20, width=10)

    def test_board_initialization(self):
        self.assertEqual(len(self.game.board), 20)
        self.assertEqual(len(self.game.board[0]), 10)
        self.assertTrue(all(cell == 0 for row in self.game.board for cell in row))
        self.assertEqual(self.game.score, 0)
        self.assertFalse(self.game.game_over)

    def test_board_empty_after_init(self):
        for row in self.game.board:
            for cell in row:
                self.assertEqual(cell, 0)

    def test_new_piece_has_valid_structure(self):
        piece = self.game.new_piece()
        self.assertIn('shape', piece)
        self.assertIn('rotation', piece)
        self.assertIn('x', piece)
        self.assertIn('y', piece)
        self.assertIn('color', piece)
        self.assertIsInstance(piece['shape'], list)
        self.assertIsInstance(piece['rotation'], int)
        self.assertIsInstance(piece['x'], int)
        self.assertIsInstance(piece['y'], int)

    def test_new_piece_starts_at_top(self):
        piece = self.game.new_piece()
        self.assertEqual(piece['y'], 0)
        self.assertGreaterEqual(piece['x'], 0)
        self.assertLessEqual(piece['x'], self.game.width - 1)

class TestTetrisCollision(unittest.TestCase):
    def setUp(self):
        self.game = Tetris(height=20, width=10)

    def test_no_collision_in_open_space(self):
        piece = {
            'shape': [[(0, 0), (0, 1)]],
            'rotation': 0, 'x': 0, 'y': 0, 'color': 1
        }
        self.assertFalse(self.game.collide(piece))

    def test_collision_left_wall(self):
        piece = {
            'shape': [[(0, 0)]],
            'rotation': 0, 'x': -1, 'y': 0, 'color': 1
        }
        self.assertTrue(self.game.collide(piece))

    def test_collision_right_wall(self):
        piece = {
            'shape': [[(0, 0)]],
            'rotation': 0, 'x': self.game.width, 'y': 0, 'color': 1
        }
        self.assertTrue(self.game.collide(piece))

    def test_collision_floor(self):
        piece = {
            'shape': [[(0, 0)]],
            'rotation': 0, 'x': 0, 'y': self.game.height, 'color': 1
        }
        self.assertTrue(self.game.collide(piece))

    def test_collision_with_board_cell(self):
        self.game.board[2][3] = 1
        piece = {
            'shape': [[(0, 0)]],
            'rotation': 0, 'x': 3, 'y': 2, 'color': 1
        }
        self.assertTrue(self.game.collide(piece))

    def test_collision_with_dx_offset(self):
        piece = {
            'shape': [[(0, 0)]],
            'rotation': 0, 'x': 4, 'y': 0, 'color': 1
        }
        self.assertTrue(self.game.collide(piece, dx=self.game.width))

    def test_no_collision_with_negative_y(self):
        piece = {
            'shape': [[(0, 0)]],
            'rotation': 0, 'x': 0, 'y': -1, 'color': 1
        }
        self.assertFalse(self.game.collide(piece))

class TestTetrisMovement(unittest.TestCase):
    def setUp(self):
        self.game = Tetris(height=20, width=10)

    def test_move_left(self):
        initial_x = self.game.current_piece['x']
        self.game.move(-1, 0)
        self.assertEqual(self.game.current_piece['x'], initial_x - 1)

    def test_move_right(self):
        initial_x = self.game.current_piece['x']
        self.game.move(1, 0)
        self.assertEqual(self.game.current_piece['x'], initial_x + 1)

    def test_move_down(self):
        initial_y = self.game.current_piece['y']
        self.game.move(0, 1)
        self.assertEqual(self.game.current_piece['y'], initial_y + 1)

    def test_move_returns_true_on_success(self):
        result = self.game.move(0, 1)
        self.assertTrue(result)

    def test_blocked_move_does_not_move(self):
        self.game.board[1][4] = 1
        self.game.current_piece['x'] = 4
        self.game.current_piece['y'] = 0
        self.game.current_piece['shape'] = [[(0, 0)]]
        self.game.current_piece['rotation'] = 0
        old_x = self.game.current_piece['x']
        old_y = self.game.current_piece['y']
        self.game.move(0, 1)
        self.assertEqual(self.game.current_piece['x'], old_x)
        self.assertEqual(self.game.current_piece['y'], old_y)

    def test_freezing_triggers_on_down_blocked(self):
        self.game.board[1][4] = 1
        self.game.current_piece['x'] = 4
        self.game.current_piece['y'] = 0
        self.game.current_piece['shape'] = [[(0, 0)]]
        self.game.current_piece['rotation'] = 0
        with patch.object(self.game, 'freeze') as mock_freeze:
            self.game.move(0, 1)
            mock_freeze.assert_called_once()

class TestTetrisRotation(unittest.TestCase):
    def setUp(self):
        self.game = Tetris(height=20, width=10)

    def test_T_piece_rotation_changes(self):
        self.game.current_piece['shape'] = SHAPES['T']
        self.game.current_piece['rotation'] = 0
        self.game.rotate(self.game.current_piece)
        self.assertEqual(self.game.current_piece['rotation'], 1)

    def test_T_piece_full_rotation_cycles(self):
        self.game.current_piece['shape'] = SHAPES['T']
        rotations = len(SHAPES['T'])
        for _ in range(rotations):
            self.game.rotate(self.game.current_piece)
        self.assertEqual(self.game.current_piece['rotation'], 0)

    def test_O_piece_rotation_stays_same(self):
        self.game.current_piece['shape'] = SHAPES['O']
        self.game.current_piece['rotation'] = 0
        self.game.rotate(self.game.current_piece)
        self.assertEqual(self.game.current_piece['rotation'], 0)

    def test_I_piece_rotation_changes(self):
        self.game.current_piece['shape'] = SHAPES['I']
        self.game.current_piece['rotation'] = 0
        self.game.rotate(self.game.current_piece)
        self.assertEqual(self.game.current_piece['rotation'], 1 % len(SHAPES['I']))

class TestTetrisLineClearing(unittest.TestCase):
    def setUp(self):
        self.game = Tetris(height=20, width=10)

    def test_clear_one_line_scores_100(self):
        for x in range(self.game.width):
            self.game.board[19][x] = 1
        self.game.score = 0
        self.game.clear_lines()
        self.assertEqual(self.game.score, 100)

    def test_clear_two_lines_scores_200(self):
        for x in range(self.game.width):
            self.game.board[18][x] = 1
            self.game.board[19][x] = 2
        self.game.score = 0
        self.game.clear_lines()
        self.assertEqual(self.game.score, 200)

    def test_lines_shift_down_after_clear(self):
        self.game.board[18][0] = 5
        for x in range(self.game.width):
            self.game.board[19][x] = 1
        self.game.clear_lines()
        self.assertEqual(self.game.board[19][0], 5)

    def test_new_row_inserted_at_top_after_clear(self):
        for x in range(self.game.width):
            self.game.board[19][x] = 1
        self.game.clear_lines()
        self.assertTrue(all(cell == 0 for cell in self.game.board[0]))

    def test_incomplete_line_not_cleared(self):
        self.game.board[19][0] = 1
        self.game.board[19][1] = 1
        self.game.score = 0
        self.game.clear_lines()
        self.assertEqual(self.game.score, 0)
        self.assertNotEqual(self.game.board[19][0], 0)

    def test_board_shrinks_by_one_after_clear(self):
        for x in range(self.game.width):
            self.game.board[19][x] = 1
        board_height_before = len(self.game.board)
        self.game.clear_lines()
        self.assertEqual(len(self.game.board), board_height_before)

    def test_multiple_clears_accumulate_score(self):
        for x in range(self.game.width):
            self.game.board[19][x] = 1
        self.game.clear_lines()
        for x in range(self.game.width):
            self.game.board[19][x] = 1
        self.game.clear_lines()
        self.assertEqual(self.game.score, 200)

class TestTetrisGameOver(unittest.TestCase):
    def setUp(self):
        self.game = Tetris(height=20, width=10)

    def test_game_over_not_set_initially(self):
        self.assertFalse(self.game.game_over)

    def test_game_over_on_blocked_spawn(self):
        for y in range(3):
            for x in range(3, 7):
                self.game.board[y][x] = 1
        self.game.current_piece['shape'] = [[(0, 0)]]
        self.game.current_piece['rotation'] = 0
        self.game.current_piece['x'] = 4
        self.game.current_piece['y'] = 0
        with patch.object(self.game, 'new_piece', return_value=self.game.current_piece):
            self.game.freeze()
        self.assertTrue(self.game.game_over)

class TestTetrisWithMockedRandom(unittest.TestCase):
    @patch('random.choice')
    def test_deterministic_piece_creation(self, mock_choice):
        mock_choice.side_effect = ['I', curses.COLOR_RED]
        game = Tetris()
        self.assertEqual(game.current_piece['shape'], SHAPES['I'])
        self.assertEqual(game.current_piece['color'], curses.COLOR_RED)

    @patch('random.choice')
    def test_multiple_pieces_deterministic(self, mock_choice):
        mock_choice.side_effect = ['O', 2, 'T', 3, 'S', 4]
        game = Tetris()
        self.assertEqual(game.current_piece['shape'], SHAPES['O'])
        game.current_piece = game.new_piece()
        self.assertEqual(game.current_piece['shape'], SHAPES['T'])
        game.current_piece = game.new_piece()
        self.assertEqual(game.current_piece['shape'], SHAPES['S'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
